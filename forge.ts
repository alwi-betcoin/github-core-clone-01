// forge.ts — the forge's state: one viewer, a registry of repositories, and
// per-repository git objects, refs, labels, issues and pull requests. Every
// surface (git smart HTTP, REST, GraphQL, MCP) reads and writes through here,
// so an object created on one surface is the same object on all the others.
//
// Determinism: ids come from counters and timestamps from a logical clock
// (a fixed epoch plus a per-mutation tick), never from the wall clock or a
// random source, so two identical request sequences produce identical state.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  commitClosure,
  hashObject,
  isAncestor,
  parseCommit,
  parseTree,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitcore.ts';

export const CLOCK_EPOCH_SEC = 1735689600; // 2025-01-01T00:00:00Z

export interface LabelRecord {
  name: string;
  color: string;
}

export interface CommentRecord {
  id: number;
  body: string;
  seq: number;
  createdAt: string;
}

export interface IssueRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRecord[];
  seq: number;
  createdAt: string;
}

export interface PullRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  comments: CommentRecord[];
  seq: number;
  createdAt: string;
}

export interface FlatFile {
  oid: string;
  mode: string;
}

/** One repository: its git store, refs, and its issue/pull tracker state. */
export class Repo {
  readonly dbId: number;
  readonly name: string;
  ownerLogin: string | null = null;
  isPrivate: boolean;
  description: string;
  readonly objects = new Map<string, GitObject>();
  readonly refs = new Map<string, string>();
  headRef = 'refs/heads/main';
  readonly labels = new Map<string, LabelRecord>();
  readonly issues = new Map<number, IssueRecord>();
  readonly pulls = new Map<number, PullRecord>();
  nextNumber = 1;
  private objectSeq = new Map<string, number>();
  private seqCounter = 0;

  constructor(dbId: number, name: string, isPrivate: boolean, description: string) {
    this.dbId = dbId;
    this.name = name;
    this.isPrivate = isPrivate;
    this.description = description;
  }

  get defaultBranch(): string {
    return this.headRef.replace(/^refs\/heads\//, '');
  }

  nextSeq(): number {
    this.seqCounter += 1;
    return this.seqCounter;
  }

  seqOf(oid: string): number {
    return this.objectSeq.get(oid) ?? 0;
  }

  /** Store an object (idempotent) and remember its insertion order. */
  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) {
      this.objects.set(oid, { type, data });
      this.objectSeq.set(oid, this.nextSeq());
    }
    return oid;
  }

  putExisting(oid: string, object: GitObject): void {
    if (!this.objects.has(oid)) {
      this.objects.set(oid, object);
      this.objectSeq.set(oid, this.nextSeq());
    }
  }

  tipOf(ref: string): string | null {
    return this.refs.get(ref) ?? null;
  }

  branchTip(branch: string): string | null {
    return this.tipOf(`refs/heads/${branch}`);
  }

  // ------------------------------------------------------------- git reads

  /** Flatten a commit's tree into path -> file entry (files only). */
  flatten(commitOid: string): Map<string, FlatFile> {
    const out = new Map<string, FlatFile>();
    const commit = this.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return out;
    const walk = (treeOid: string, prefix: string): void => {
      const tree = this.objects.get(treeOid);
      if (!tree || tree.type !== 'tree') return;
      for (const entry of parseTree(tree.data)) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.mode === '40000') walk(entry.oid, path);
        else if (entry.mode !== '160000') out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(parseCommit(commit.data).tree, '');
    return out;
  }

  /** Build nested trees from a flattened file map; returns the root tree id. */
  buildTreeFromFlat(files: ReadonlyMap<string, FlatFile>): string {
    interface Node {
      files: Map<string, FlatFile>;
      dirs: Map<string, Node>;
    }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, file] of files) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        if (!node.dirs.has(segments[i])) node.dirs.set(segments[i], { files: new Map(), dirs: new Map() });
        node = node.dirs.get(segments[i])!;
      }
      node.files.set(segments[segments.length - 1], file);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject('tree', buildTree(entries));
    };
    return build(root);
  }

  /** Read one path out of a commit: a file, a directory listing, or null. */
  readPath(
    commitOid: string,
    path: string,
  ): { kind: 'file'; oid: string; data: Buffer } | { kind: 'dir'; entries: Array<TreeEntry & { path: string }> } | null {
    const commit = this.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return null;
    let treeOid = parseCommit(commit.data).tree;
    const segments = path === '' ? [] : path.split('/');
    for (let i = 0; i < segments.length; i += 1) {
      const tree = this.objects.get(treeOid);
      if (!tree || tree.type !== 'tree') return null;
      const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[i]);
      if (!entry) return null;
      if (i === segments.length - 1) {
        if (entry.mode === '40000') {
          const dir = this.objects.get(entry.oid);
          if (!dir || dir.type !== 'tree') return null;
          return {
            kind: 'dir',
            entries: parseTree(dir.data).map((child) => ({ ...child, path: path ? `${path}/${child.name}` : child.name })),
          };
        }
        const blob = this.objects.get(entry.oid);
        if (!blob || blob.type !== 'blob') return null;
        return { kind: 'file', oid: entry.oid, data: blob.data };
      }
      if (entry.mode !== '40000') return null;
      treeOid = entry.oid;
    }
    const tree = this.objects.get(treeOid);
    if (!tree || tree.type !== 'tree') return null;
    return { kind: 'dir', entries: parseTree(tree.data).map((child) => ({ ...child, path: child.name })) };
  }

  /** Commits reachable from `from`, newest first (timestamp, then insertion). */
  listCommits(fromOid: string): Array<{ oid: string; message: string; timestamp: number }> {
    const closure = commitClosure(this.objects, [fromOid]);
    const rows: Array<{ oid: string; message: string; timestamp: number; seq: number }> = [];
    for (const oid of closure) {
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const view = parseCommit(object.data);
      rows.push({ oid, message: view.message, timestamp: view.timestamp, seq: this.seqOf(oid) });
    }
    rows.sort((a, b) => b.timestamp - a.timestamp || b.seq - a.seq);
    return rows;
  }

  /** The best common ancestor of two commits, or null when unrelated. */
  mergeBase(a: string, b: string): string | null {
    const depths = (start: string): Map<string, number> => {
      const map = new Map<string, number>();
      let frontier = [start];
      let depth = 0;
      while (frontier.length) {
        const next: string[] = [];
        for (const oid of frontier) {
          if (map.has(oid)) continue;
          map.set(oid, depth);
          const object = this.objects.get(oid);
          if (object && object.type === 'commit') next.push(...parseCommit(object.data).parents);
        }
        frontier = next;
        depth += 1;
      }
      return map;
    };
    const fromA = depths(a);
    const fromB = depths(b);
    let best: string | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const [oid, depthA] of fromA) {
      const depthB = fromB.get(oid);
      if (depthB === undefined) continue;
      const score = depthA + depthB;
      if (score < bestScore) {
        bestScore = score;
        best = oid;
      }
    }
    return best;
  }
}

/** Three-way tree merge outcome for one pull request. */
export type MergeOutcome =
  | { ok: true; files: Map<string, FlatFile> }
  | { ok: false; conflictPath: string };

/** The whole forge: viewer binding, the repo registry, id/clock sequences. */
export class Forge {
  viewerLogin: string | null = null;
  readonly repos = new Map<string, Repo>();
  private repoSeq = 0;
  private entitySeq = 0;
  private clockSeq = 0;
  requestSeq = 0;

  /** A deterministic ISO timestamp: the fixed epoch plus one tick per call. */
  nowIso(): string {
    this.clockSeq += 1;
    return new Date((CLOCK_EPOCH_SEC + this.clockSeq) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /** The current logical-clock reading in epoch seconds (for commit objects). */
  nowSec(): number {
    this.clockSeq += 1;
    return CLOCK_EPOCH_SEC + this.clockSeq;
  }

  nextEntityId(): number {
    this.entitySeq += 1;
    return this.entitySeq;
  }

  /** The identity REST/GraphQL/MCP-created commits carry. */
  identity(): { name: string; email: string } {
    const login = this.viewerLogin ?? 'forge';
    return { name: login, email: `${login}@example.invalid` };
  }

  /** Record the token owner's login the first time an owner is addressed. */
  bindViewer(login: string): void {
    if (this.viewerLogin === null && login !== '') this.viewerLogin = login;
  }

  /**
   * Find a repo by owner + name under the forge's ownership rule: a repo
   * belongs to the token's login; the first owner-addressed access binds an
   * unbound repo, and any other owner reads as "not found" (never a 403).
   */
  findRepo(owner: string, name: string): Repo | null {
    const repo = this.repos.get(name);
    if (!repo) return null;
    this.bindViewer(owner);
    if (this.viewerLogin !== owner) return null;
    if (repo.ownerLogin === null) repo.ownerLogin = owner;
    if (repo.ownerLogin !== owner) return null;
    return repo;
  }

  /** Find a repo the caller owns by name alone (creation surfaces). */
  ownRepo(name: string): Repo | null {
    return this.repos.get(name) ?? null;
  }

  repoByDbId(dbId: number): Repo | null {
    for (const repo of this.repos.values()) if (repo.dbId === dbId) return repo;
    return null;
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    if (this.repos.has(name)) return null;
    this.repoSeq += 1;
    const repo = new Repo(this.repoSeq, name, isPrivate, description);
    if (this.viewerLogin !== null) repo.ownerLogin = this.viewerLogin;
    this.repos.set(name, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.findRepo(owner, name);
    if (!repo) return false;
    this.repos.delete(name);
    return true;
  }

  /** The caller's repos, in creation order (the pagination source). */
  ownRepos(): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.ownerLogin === null || repo.ownerLogin === this.viewerLogin);
  }

  // ------------------------------------------------------- commits via API

  /** Create a commit on `branch` with `treeOid`, authored by the forge. */
  commitOnBranch(repo: Repo, branch: string, treeOid: string, message: string): string {
    const tip = repo.branchTip(branch);
    const { name, email } = this.identity();
    const stamp = this.nowSec();
    const who = `${name} <${email}> ${stamp} +0000`;
    const data = buildCommit({
      tree: treeOid,
      parents: tip ? [tip] : [],
      author: who,
      committer: who,
      message: message.endsWith('\n') ? message : `${message}\n`,
    });
    const oid = repo.putObject('commit', data);
    repo.refs.set(`refs/heads/${branch}`, oid);
    return oid;
  }

  /** Write `data` at `path` on `branch`; returns the new commit and blob ids. */
  putContent(
    repo: Repo,
    branch: string,
    path: string,
    data: Buffer,
    message: string,
  ): { commitOid: string; blobOid: string } {
    const tip = repo.branchTip(branch);
    const files = tip ? repo.flatten(tip) : new Map<string, FlatFile>();
    const blobOid = repo.putObject('blob', data);
    files.set(path, { oid: blobOid, mode: '100644' });
    const treeOid = repo.buildTreeFromFlat(files);
    const commitOid = this.commitOnBranch(repo, branch, treeOid, message);
    return { commitOid, blobOid };
  }

  /** Remove `path` on `branch`; returns the new commit id. */
  deleteContent(repo: Repo, branch: string, path: string, message: string): string {
    const tip = repo.branchTip(branch);
    const files = tip ? repo.flatten(tip) : new Map<string, FlatFile>();
    files.delete(path);
    const treeOid = repo.buildTreeFromFlat(files);
    return this.commitOnBranch(repo, branch, treeOid, message);
  }

  /** Create an issue in `repo` (numbers are shared with pull requests). */
  newIssue(repo: Repo, title: string, body: string, labels: string[]): IssueRecord {
    const issue: IssueRecord = {
      id: this.nextEntityId(),
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      seq: repo.nextSeq(),
      createdAt: this.nowIso(),
    };
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  /** Create a pull request in `repo` from `headRef` into `baseRef`. */
  newPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): PullRecord {
    const pull: PullRecord = {
      id: this.nextEntityId(),
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      comments: [],
      seq: repo.nextSeq(),
      createdAt: this.nowIso(),
    };
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /** Append a comment to an issue or pull request's comment list. */
  addComment(target: { comments: CommentRecord[] }, body: string): CommentRecord {
    const comment: CommentRecord = {
      id: this.nextEntityId(),
      body,
      seq: this.nextEntityId(),
      createdAt: this.nowIso(),
    };
    target.comments.push(comment);
    return comment;
  }

  /**
   * The three-way merge test + merge for a pull request. With `dryRun` the
   * merge is only tested. A squash/merge commit's tree is the merged tree.
   */
  mergePull(repo: Repo, pull: PullRecord, method: string, dryRun: boolean): { ok: true; sha: string } | { ok: false; conflictPath: string } {
    const baseTip = repo.branchTip(pull.baseRef);
    const headTip = repo.branchTip(pull.headRef);
    if (!baseTip || !headTip) return { ok: false, conflictPath: '' };
    const base = repo.mergeBase(baseTip, headTip) ?? baseTip;
    const baseFiles = repo.flatten(base);
    const ours = repo.flatten(baseTip);
    const theirs = repo.flatten(headTip);
    const merged = new Map<string, FlatFile>();
    const paths = new Set([...baseFiles.keys(), ...ours.keys(), ...theirs.keys()]);
    for (const path of paths) {
      const inBase = baseFiles.get(path)?.oid;
      const inOurs = ours.get(path)?.oid;
      const inTheirs = theirs.get(path)?.oid;
      if (inOurs === inTheirs) {
        if (inOurs !== undefined) merged.set(path, ours.get(path)!);
        continue;
      }
      if (inBase === inOurs) {
        if (inTheirs !== undefined) merged.set(path, theirs.get(path)!);
        continue;
      }
      if (inBase === inTheirs) {
        if (inOurs !== undefined) merged.set(path, ours.get(path)!);
        continue;
      }
      return { ok: false, conflictPath: path };
    }
    if (dryRun) return { ok: true, sha: '' };
    const treeOid = repo.buildTreeFromFlat(merged);
    const { name, email } = this.identity();
    const stamp = this.nowSec();
    const who = `${name} <${email}> ${stamp} +0000`;
    let parents: string[];
    let message: string;
    if (method === 'merge') {
      parents = [baseTip, headTip];
      message = `Merge pull request #${pull.number} from ${pull.headRef}\n`;
    } else {
      parents = [baseTip];
      message = pull.body ? `${pull.title}\n\n${pull.body}\n` : `${pull.title}\n`;
    }
    const data = buildCommit({ tree: treeOid, parents, author: who, committer: who, message });
    const sha = repo.putObject('commit', data);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    return { ok: true, sha };
  }
}

export { ZERO_OID, isAncestor };
