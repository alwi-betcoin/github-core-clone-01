// githttp.ts — git smart HTTP: ref advertisement (protocol v0 and v2),
// ls-refs, fetch (want/have negotiation, shallow and deepen), and
// receive-pack (ref updates with report-status). The wire shapes are the ones
// real git and the suite's in-process client speak; there is no git binary.

import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  commitClosure,
  decodePktLines,
  isAncestor,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  pktLine,
  readPack,
  writePack,
  type GitObject,
} from './gitcore.ts';
import type { Forge, Repo } from './forge.ts';

const AGENT = 'makefun-forge/1.0';
const UPLOAD_CAPS = `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=${AGENT}`;
const RECEIVE_CAPS = `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;

export interface GitReply {
  status: number;
  contentType: string;
  body: Buffer;
}

function jsonError(status: number, message: string): GitReply {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify({ message })}\n`) };
}

/** All refs a repo advertises, sorted by name, with peeled tag targets. */
function advertisedRefs(repo: Repo): Array<{ name: string; oid: string; peeled?: string }> {
  const names = [...repo.refs.keys()].sort();
  const out: Array<{ name: string; oid: string; peeled?: string }> = [];
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    out.push({ name, oid });
    const object = repo.objects.get(oid);
    if (object && object.type === 'tag') {
      const target = peelToCommit(repo.objects, oid);
      if (target && target !== oid) out.push({ name: `${name}^{}`, oid: target });
    }
  }
  return out;
}

/** GET info/refs: the service preamble plus a v2 capability list or v0 refs. */
export function advertisement(repo: Repo, service: string, v2: boolean): GitReply {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  if (v2 && service === 'git-upload-pack') {
    parts.push(pktLine('version 2\n'));
    parts.push(pktLine(`agent=${AGENT}\n`));
    parts.push(pktLine('ls-refs=unborn\n'));
    parts.push(pktLine('fetch=shallow wait-for-done\n'));
    parts.push(pktLine('object-format=sha1\n'));
    parts.push(PKT_FLUSH);
    return { status: 200, contentType: `application/x-${service}-advertisement`, body: Buffer.concat(parts) };
  }
  const caps = service === 'git-upload-pack' ? `${UPLOAD_CAPS} symref=HEAD:${repo.headRef}` : RECEIVE_CAPS;
  const refs = advertisedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}`));
  } else {
    const headOid = repo.tipOf(repo.headRef) ?? ZERO_OID;
    parts.push(pktLine(`${headOid} HEAD\0${caps}`));
    for (const ref of refs) parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
  }
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: `application/x-${service}-advertisement`, body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------------------
// ls-refs (protocol v2)
// ---------------------------------------------------------------------------

function lsRefs(repo: Repo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headTip = repo.tipOf(repo.headRef);
  if (matches('HEAD')) {
    if (headTip) {
      parts.push(pktLine(`${headTip} HEAD${symrefs ? ` symref-target:${repo.headRef}` : ''}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${repo.headRef}` : ''}\n`));
    }
  }
  for (const ref of advertisedRefs(repo)) {
    if (ref.name.endsWith('^{}')) continue;
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const object = repo.objects.get(ref.oid);
      if (object && object.type === 'tag') {
        const target = peelToCommit(repo.objects, ref.oid);
        if (target) line += ` peeled:${target}`;
      }
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// fetch (protocol v2 and v0 share the object computation)
// ---------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  done: boolean;
}

interface FetchPlan {
  acks: string[];
  shallowLines: string[];
  pack: Buffer;
}

/** Tree+blob closure of one commit (not its ancestors). */
function treeClosure(repo: Repo, commitOid: string, into: Set<string>): void {
  const commit = repo.objects.get(commitOid);
  if (!commit || commit.type !== 'commit') return;
  const queue = [parseCommit(commit.data).tree];
  while (queue.length) {
    const oid = queue.pop()!;
    if (into.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    into.add(oid);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) if (entry.mode !== '160000') queue.push(entry.oid);
    }
  }
}

function planFetch(repo: Repo, request: FetchRequest): FetchPlan {
  const store = repo.objects;
  const clientShallow = new Set(request.shallow);

  // What the client already holds: the have closure, bounded by its shallow
  // list, plus those commits' trees and blobs.
  const haveCommits = commitClosure(store, request.haves, clientShallow);
  const haveObjects = new Set<string>();
  for (const oid of haveCommits) {
    haveObjects.add(oid);
    treeClosure(repo, oid, haveObjects);
  }
  for (const have of request.haves) {
    if (store.has(have) && !haveCommits.has(have)) {
      // A non-commit have (a tree/blob the client names): exclude its closure.
      const queue = [have];
      while (queue.length) {
        const oid = queue.pop()!;
        if (haveObjects.has(oid)) continue;
        const object = store.get(oid);
        if (!object) continue;
        haveObjects.add(oid);
        if (object.type === 'tree') for (const entry of parseTree(object.data)) queue.push(entry.oid);
        if (object.type === 'tag') queue.push(parseTag(object.data).object);
      }
    }
  }

  // The commits the client should end up with, honouring depth.
  const wantCommits: string[] = [];
  for (const want of request.wants) {
    const commit = peelToCommit(store, want);
    if (commit) wantCommits.push(commit);
  }
  const included = new Set<string>();
  const boundary = new Set<string>();
  if (request.depth === null && request.deepenSince === null && request.deepenNot.length === 0) {
    for (const oid of commitClosure(store, wantCommits)) included.add(oid);
  } else {
    // Breadth-first layers from the wants give each commit its depth. With a
    // plain depth limit the walk stops expanding at the boundary layer: a
    // depth-1 clone of a long history must not walk the whole history.
    const layer = new Map<string, number>();
    let frontier = [...new Set(wantCommits)];
    let depth = 1;
    const expandable = request.deepenSince === null && request.depth !== null;
    while (frontier.length) {
      const next: string[] = [];
      for (const oid of frontier) {
        if (layer.has(oid)) continue;
        layer.set(oid, depth);
        if (expandable && depth >= (request.depth ?? 0)) continue;
        const object = store.get(oid);
        if (object && object.type === 'commit') next.push(...parseCommit(object.data).parents);
      }
      frontier = next;
      depth += 1;
    }
    let excluded = new Set<string>();
    if (request.deepenNot.length) {
      const notTips: string[] = [];
      for (const name of request.deepenNot) {
        const oid = repo.refs.get(name) ?? (store.has(name) ? name : null);
        if (oid) notTips.push(oid);
      }
      excluded = commitClosure(store, notTips);
    }
    for (const [oid, at] of layer) {
      if (request.depth !== null && at > request.depth) continue;
      if (request.deepenSince !== null) {
        const object = store.get(oid);
        if (object && object.type === 'commit' && parseCommit(object.data).timestamp < request.deepenSince) continue;
      }
      if (excluded.has(oid)) continue;
      included.add(oid);
    }
    for (const oid of included) {
      const object = store.get(oid);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.length && parents.some((parent) => !included.has(parent) && store.has(parent))) boundary.add(oid);
    }
  }

  const shallowLines: string[] = [];
  for (const oid of boundary) if (!clientShallow.has(oid)) shallowLines.push(`shallow ${oid}`);
  for (const oid of clientShallow) {
    if (included.has(oid) && !boundary.has(oid)) shallowLines.push(`unshallow ${oid}`);
  }

  // Objects to send: the included commits the client lacks, their trees and
  // blobs, and any tag objects on the path from a want to an included commit.
  const send = new Set<string>();
  for (const oid of included) {
    if (haveCommits.has(oid)) continue;
    send.add(oid);
    const trees = new Set<string>();
    treeClosure(repo, oid, trees);
    for (const treeOid of trees) send.add(treeOid);
  }
  for (const want of request.wants) {
    let current = want;
    for (let guard = 0; guard < 32; guard += 1) {
      const object = store.get(current);
      if (!object || object.type !== 'tag') break;
      if (included.has(parseTag(object.data).object) || included.has(current)) send.add(current);
      current = parseTag(object.data).object;
    }
    // A want naming a tree or blob directly: send its closure.
    const object = store.get(want);
    if (object && object.type === 'tree') {
      const trees = new Set<string>();
      const queue = [want];
      while (queue.length) {
        const oid = queue.pop()!;
        if (trees.has(oid)) continue;
        const entry = store.get(oid);
        if (!entry) continue;
        trees.add(oid);
        if (entry.type === 'tree') for (const child of parseTree(entry.data)) queue.push(child.oid);
      }
      for (const oid of trees) send.add(oid);
    } else if (object && object.type === 'blob') {
      send.add(want);
    }
  }
  for (const oid of haveObjects) send.delete(oid);

  const ordered: GitObject[] = [];
  const byType = (type: string) => [...send].filter((oid) => store.get(oid)?.type === type);
  for (const type of ['commit', 'tree', 'blob', 'tag']) {
    for (const oid of byType(type)) ordered.push(store.get(oid)!);
  }

  const acks: string[] = [];
  const common = request.haves.filter((have) => haveCommits.has(have));
  if (request.haves.length) {
    if (common.length) for (const oid of common) acks.push(`ACK ${oid}`);
    else acks.push('NAK');
  }
  return { acks, shallowLines, pack: writePack(ordered) };
}

/** Wrap pack bytes in sideband-1 pkt-lines (32 KiB chunks). */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(offset, offset + CHUNK)])));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  return parts;
}

function fetchV2(repo: Repo, args: string[]): Buffer {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, deepenSince: null, deepenNot: [], done: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) request.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) request.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) request.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) request.depth = Number(arg.slice(7).trim());
    else if (arg.startsWith('deepen-since ')) request.deepenSince = Number(arg.slice(13).trim());
    else if (arg.startsWith('deepen-not ')) request.deepenNot.push(arg.slice(11).trim());
    else if (arg === 'done') request.done = true;
  }
  const plan = planFetch(repo, request);
  const parts: Buffer[] = [];
  if (request.haves.length) {
    parts.push(pktLine('acknowledgments\n'));
    for (const ack of plan.acks) parts.push(pktLine(`${ack}\n`));
    if (!request.done) parts.push(pktLine('ready\n'));
    parts.push(PKT_DELIM);
  }
  if (plan.shallowLines.length) {
    parts.push(pktLine('shallow-info\n'));
    for (const line of plan.shallowLines) parts.push(pktLine(`${line}\n`));
    parts.push(PKT_DELIM);
  }
  if (request.done) {
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPack(plan.pack));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePack(repo: Repo, body: Buffer): GitReply {
  const { items, rest } = decodePktLines(body);
  const commands: PushCommand[] = [];
  let capabilities = new Set<string>();
  let first = true;
  for (const item of items) {
    if (item.kind === 'flush') break;
    if (item.kind !== 'data') continue;
    let line = item.payload.toString('utf8').replace(/\n$/, '');
    if (first) {
      first = false;
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        capabilities = new Set(line.slice(nul + 1).split(' ').filter(Boolean));
        line = line.slice(0, nul);
      }
    }
    const fields = line.split(' ');
    if (fields.length >= 3) commands.push({ oldOid: fields[0], newOid: fields[1], ref: fields[2] });
  }

  let unpackError: string | null = null;
  if (rest.length > 0) {
    if (rest.subarray(0, 4).toString('ascii') === 'PACK') {
      try {
        const objects = readPack(rest, (oid) => repo.objects.get(oid));
        for (const [oid, object] of objects) repo.putExisting(oid, object);
      } catch (err) {
        unpackError = err instanceof Error ? err.message : 'unpack failed';
      }
    } else if (commands.some((command) => command.newOid !== ZERO_OID)) {
      unpackError = 'expected a packfile';
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    if (unpackError !== null) {
      results.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.oldOid !== current) {
      results.push({ ref: command.ref, ok: false, reason: 'stale info' });
      continue;
    }
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    const object = repo.objects.get(command.newOid);
    if (!object) {
      results.push({ ref: command.ref, ok: false, reason: 'missing object' });
      continue;
    }
    if (command.ref.startsWith('refs/heads/') && current !== ZERO_OID) {
      const currentCommit = peelToCommit(repo.objects, current);
      const newCommit = peelToCommit(repo.objects, command.newOid);
      if (!newCommit) {
        results.push({ ref: command.ref, ok: false, reason: 'invalid object' });
        continue;
      }
      if (currentCommit && !isAncestor(repo.objects, currentCommit, newCommit)) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }

  const wantsReport = capabilities.has('report-status') || capabilities.has('report-status-v2');
  if (!wantsReport) return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.alloc(0) };
  const lines: string[] = [unpackError !== null ? `unpack ${unpackError}` : 'unpack ok'];
  for (const result of results) lines.push(result.ok ? `ok ${result.ref}` : `ng ${result.ref} ${result.reason}`);
  const reportParts: Buffer[] = lines.map((line) => pktLine(`${line}\n`));
  reportParts.push(PKT_FLUSH);
  const report = Buffer.concat(reportParts);
  if (capabilities.has('side-band-64k')) {
    const parts: Buffer[] = [];
    const CHUNK = 32768;
    for (let offset = 0; offset < report.length; offset += CHUNK) {
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), report.subarray(offset, offset + CHUNK)])));
    }
    parts.push(PKT_FLUSH);
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(parts) };
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: report };
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

/**
 * Handle one git smart-HTTP request. `tail` is the path after
 * `/{owner}/{repo}.git` (e.g. `/info/refs`), `query` the parsed query params,
 * `v2` whether the client sent `Git-Protocol: version=2`.
 */
export function handleGit(
  forge: Forge,
  owner: string,
  repoName: string,
  tail: string,
  query: URLSearchParams,
  method: string,
  body: Buffer,
  v2: boolean,
): GitReply {
  const repo = forge.findRepo(owner, repoName);
  if (!repo) return jsonError(404, 'Not Found');
  if (tail === '/info/refs' && method === 'GET') {
    const service = query.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return jsonError(400, 'unknown service');
    return advertisement(repo, service, v2);
  }
  if (tail === '/git-upload-pack' && method === 'POST') {
    if (v2) {
      const { items } = decodePktLines(body);
      const lines: string[] = [];
      let section: 'header' | 'args' = 'header';
      let command = '';
      const args: string[] = [];
      for (const item of items) {
        if (item.kind === 'delim') {
          section = 'args';
          continue;
        }
        if (item.kind === 'flush') break;
        if (item.kind !== 'data') continue;
        const line = item.payload.toString('utf8').replace(/\n$/, '');
        if (section === 'header') {
          if (line.startsWith('command=')) command = line.slice('command='.length);
        } else {
          args.push(line);
        }
        lines.push(line);
      }
      if (command === 'ls-refs') {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefs(repo, args) };
      }
      if (command === 'fetch') {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchV2(repo, args) };
      }
      return jsonError(400, 'unknown command');
    }
    // Protocol v0: wants section, flush, negotiation section, flush.
    const { items } = decodePktLines(body);
    const wants: string[] = [];
    const firstSection: string[] = [];
    const secondSection: string[] = [];
    let section = 0;
    for (const item of items) {
      if (item.kind === 'flush') {
        section += 1;
        continue;
      }
      if (item.kind !== 'data') continue;
      const line = item.payload.toString('utf8').replace(/\n$/, '');
      if (section === 0) firstSection.push(line);
      else secondSection.push(line);
    }
    for (const line of firstSection) {
      if (line.startsWith('want ')) wants.push(line.slice(5).trim().split(' ')[0]);
      else if (line.startsWith('shallow ')) secondSection.push(line);
      else if (line.startsWith('deepen')) secondSection.push(line);
    }
    if (!wants.length) return jsonError(400, 'no wants');
    // Fold the shallow/deepen lines into the fetch request via the rest list.
    const rest = [...secondSection];
    const request: FetchRequest = { wants, haves: [], shallow: [], depth: null, deepenSince: null, deepenNot: [], done: false };
    for (const line of rest) {
      if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) request.depth = Number(line.slice(7).trim());
      else if (line.startsWith('deepen-since ')) request.deepenSince = Number(line.slice(13).trim());
      else if (line.startsWith('deepen-not ')) request.deepenNot.push(line.slice(11).trim());
      else if (line === 'done') request.done = true;
    }
    const plan = planFetch(repo, request);
    const parts: Buffer[] = [];
    for (const line of plan.shallowLines) parts.push(pktLine(`${line}\n`));
    const ack = plan.acks.find((line) => line.startsWith('ACK')) ?? 'NAK';
    parts.push(pktLine(`${ack}\n`));
    parts.push(...sidebandPack(plan.pack));
    parts.push(PKT_FLUSH);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
  }
  if (tail === '/git-receive-pack' && method === 'POST') {
    return receivePack(repo, body);
  }
  return jsonError(404, 'Not Found');
}
