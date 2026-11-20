// gitcore.ts — the git object model in-process: SHA-1 ids, loose object bytes,
// tree/commit/tag codecs, packfile read (with delta resolution) and write, and
// the pkt-line framing the smart-HTTP protocol speaks. Node built-ins only.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
const HEX40 = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return HEX40.test(value);
}

/** SHA-1 over `<type> <size>\0` + bytes: the object id git assigns. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------
// trees, commits, tags
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry without mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Build a tree object's bytes; entries are sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = Buffer.from(treeSortKey(a), 'utf8');
    const kb = Buffer.from(treeSortKey(b), 'utf8');
    return Buffer.compare(ka, kb);
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  /** Seconds from the committer line, 0 when unparsable. */
  timestamp: number;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const header = data.subarray(0, blank < 0 ? data.length : blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  const stamp = / (\d+) [+-]\d{4}$/.exec(committer);
  return { tree, parents, author, committer, message, timestamp: stamp ? Number(stamp[1]) : 0 };
}

export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`, `committer ${fields.committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const header = data.subarray(0, blank < 0 ? data.length : blank).toString('utf8');
  const fields = new Map<string, string>();
  for (const line of header.split('\n')) {
    const space = line.indexOf(' ');
    if (space > 0) fields.set(line.slice(0, space), line.slice(space + 1));
  }
  return { object: fields.get('object') ?? '', type: fields.get('type') ?? '', tag: fields.get('tag') ?? '' };
}

/** Peel an object id to the commit it names (through annotated tags), or null. */
export function peelToCommit(store: ReadonlyMap<string, GitObject>, oid: string): string | null {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const object = store.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** The commit id a tag peels to (one level of peeling for advertisements). */
export function peeledOf(store: ReadonlyMap<string, GitObject>, oid: string): string | null {
  const object = store.get(oid);
  if (!object || object.type !== 'tag') return null;
  return peelToCommit(store, oid);
}

// ---------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------

/**
 * Every commit reachable from `starts` through parent links. Commits in
 * `stopAt` are included but their parents are not followed (a shallow
 * boundary, or the far side of a have line).
 */
export function commitClosure(
  store: ReadonlyMap<string, GitObject>,
  starts: Iterable<string>,
  stopAt?: ReadonlySet<string>,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const start of starts) {
    const commit = peelToCommit(store, start);
    if (commit) queue.push(commit);
  }
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (!object || object.type !== 'commit') continue;
    seen.add(oid);
    if (stopAt && stopAt.has(oid)) continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return seen;
}

/** True when `ancestor` is `descendant` itself or reachable from it by parents. */
export function isAncestor(store: ReadonlyMap<string, GitObject>, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return false;
}

/** All objects (commits, trees, blobs, tags) reachable from the given ids. */
export function objectClosure(store: ReadonlyMap<string, GitObject>, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree, ...commit.parents);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let rest = Math.floor(size / 16);
  let first = (code << 4) | (size & 0x0f);
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** A version-2 pack of plain (undeltified) objects, with its SHA-1 trailer. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 4, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [head];
  for (const object of list) {
    parts.push(packHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Inflate one zlib stream starting at `offset`; reports where it ended. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const consumed = result.engine.bytesWritten;
  if (!consumed || consumed <= 0) throw new Error(`zlib stream at ${offset} consumed nothing`);
  return { data: result.buffer, next: offset + consumed };
}

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

/**
 * Read a packfile fully, resolving OFS/REF deltas. Returns the objects keyed
 * by id. Throws on any structural problem (the caller reports unpack errors).
 */
export function readPack(pack: Buffer, externalBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack checksum mismatch');

  interface Raw {
    offset: number;
    typeCode: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset++];
    const size0 = byte & 0x0f;
    const typeCode = (byte >> 4) & 0x07;
    let size = size0;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const entry: Raw = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let b = pack[offset++];
      let value = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset++];
        value = (value + 1) * 128 + (b & 0x7f);
      }
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has trailing bytes');

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, GitObject>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): GitObject => {
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let resolved: GitObject;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      resolved = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.typeCode === 7) {
      const base = resolvedByOid.get(entry.baseOid!) ?? externalBase?.(entry.baseOid!);
      if (!base) throw new Error('ref-delta base missing');
      resolved = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      resolved = { type: CODE_TYPE[entry.typeCode], data: entry.data };
    }
    resolving.delete(entry.offset);
    resolvedByOid.set(hashObject(resolved.type, resolved.data), resolved);
    return resolved;
  };
  for (const entry of raw) {
    const object = resolve(entry);
    objects.set(hashObject(object.type, object.data), object);
  }
  return objects;
}

// ---------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------

export const PKT_MAX_PAYLOAD = 65516;

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_MAX_PAYLOAD) throw new Error('pkt-line too long');
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type PktItem =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Decode a complete pkt-line stream; trailing raw bytes (a pack) come back too. */
export function decodePktLines(bytes: Buffer): { items: PktItem[]; rest: Buffer } {
  const items: PktItem[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      items.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      items.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      items.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3 || length > 65520 || offset + length > bytes.length) break;
    items.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { items, rest: bytes.subarray(offset) };
}
