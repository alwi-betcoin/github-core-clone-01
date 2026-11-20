// rest.ts — the REST v3 surface under /api/v3: repositories, branches,
// commits, contents, labels, issues, comments and pull requests, in the
// shapes and status codes GitHub answers (and the suite's clients expect).

import { isOid, parseCommit } from './gitcore.ts';
import type { Forge, IssueRecord, PullRecord, Repo } from './forge.ts';

export interface RestReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const NOT_FOUND: RestReply = { status: 404, body: { message: 'Not Found' } };

function message(status: number, text: string): RestReply {
  return { status, body: { message: text } };
}

// ---------------------------------------------------------------------------
// JSON shapes
// ---------------------------------------------------------------------------

export function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  const owner = repo.ownerLogin ?? forge.viewerLogin ?? '';
  return {
    id: repo.dbId,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: owner, id: 1000, type: 'User' },
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

export function issueJson(repo: Repo, issue: IssueRecord): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? '000000' };
    }),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.createdAt,
  };
}

export function pullJson(repo: Repo, pull: PullRecord): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: repo.branchTip(pull.headRef), label: `${repo.ownerLogin ?? ''}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: repo.branchTip(pull.baseRef), label: `${repo.ownerLogin ?? ''}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.createdAt,
  };
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'commit') return { sha: oid, commit: { message: '' } };
  const view = parseCommit(object.data);
  const split = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
    if (!match) return { name: line, email: '', date: '2025-01-01T00:00:00Z' };
    return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') };
  };
  return {
    sha: oid,
    commit: {
      message: view.message.replace(/\n$/, ''),
      author: split(view.author),
      committer: split(view.committer),
      tree: { sha: view.tree },
    },
    parents: view.parents.map((parent) => ({ sha: parent })),
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface Ctx {
  forge: Forge;
  baseUrl: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown> | null;
}

function paginate<T>(ctx: Ctx, items: T[]): { page: T[]; headers: Record<string, string> } {
  const perPageRaw = Number(ctx.query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const pageRaw = Number(ctx.query.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const params = new URLSearchParams(ctx.query);
    params.set('page', String(page + 1));
    params.set('per_page', String(perPage));
    const lastPage = Math.max(1, Math.ceil(items.length / perPage));
    const lastParams = new URLSearchParams(ctx.query);
    lastParams.set('page', String(lastPage));
    lastParams.set('per_page', String(perPage));
    headers.link = `<${ctx.baseUrl}/api/v3${ctx.path}?${params.toString()}>; rel="next", <${ctx.baseUrl}/api/v3${ctx.path}?${lastParams.toString()}>; rel="last"`;
  }
  return { page: slice, headers };
}

function resolveCommit(repo: Repo, ref: string): string | null {
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`)!;
  if (repo.refs.has(ref)) return repo.refs.get(ref)!;
  if (isOid(ref) && repo.objects.has(ref)) return ref;
  return null;
}

function labelNames(body: Record<string, unknown> | null): string[] {
  const raw = body?.labels;
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') names.push(entry);
    else if (entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
      names.push((entry as { name: string }).name);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// route handlers
// ---------------------------------------------------------------------------

function createRepo(ctx: Ctx): RestReply {
  const body = ctx.body ?? {};
  const name = typeof body.name === 'string' ? body.name : '';
  if (!name) return message(422, 'name is required');
  if (ctx.forge.ownRepo(name)) {
    return { status: 422, body: { message: 'name already exists on this account', errors: [{ field: 'name', code: 'custom' }] } };
  }
  const repo = ctx.forge.createRepo(name, body.private === true, typeof body.description === 'string' ? body.description : '')!;
  return { status: 201, body: repoJson(ctx.forge, repo) };
}

function contentsGet(ctx: Ctx, repo: Repo, path: string): RestReply {
  const ref = ctx.query.get('ref') ?? repo.defaultBranch;
  const commitOid = resolveCommit(repo, ref);
  if (!commitOid) return NOT_FOUND;
  const found = repo.readPath(commitOid, path);
  if (!found) return NOT_FOUND;
  if (found.kind === 'file') {
    return {
      status: 200,
      body: {
        type: 'file',
        encoding: 'base64',
        content: found.data.toString('base64'),
        name: path.split('/').pop() ?? path,
        path,
        sha: found.oid,
        size: found.data.length,
      },
    };
  }
  return {
    status: 200,
    body: found.entries.map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: entry.path,
      sha: entry.oid,
    })),
  };
}

function contentsPut(ctx: Ctx, repo: Repo, path: string): RestReply {
  const body = ctx.body ?? {};
  const content = typeof body.content === 'string' ? body.content : null;
  if (content === null || typeof body.message !== 'string') return message(422, 'content and message are required');
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  // A contents write naming an unborn branch creates it from the default
  // branch's tip (the branch-creation route the MCP setup falls back to).
  if (!repo.refs.has(`refs/heads/${branch}`) && branch !== repo.defaultBranch) {
    const baseTip = repo.branchTip(repo.defaultBranch);
    if (baseTip) repo.refs.set(`refs/heads/${branch}`, baseTip);
  }
  const tip = repo.branchTip(branch);
  const existing = tip ? repo.readPath(tip, path) : null;
  let status = 201;
  if (existing && existing.kind === 'file') {
    if (typeof body.sha !== 'string') return message(422, 'sha is required to update an existing file');
    if (body.sha !== existing.oid) return message(409, 'the sha does not match the current blob');
    status = 200;
  }
  const data = Buffer.from(content, 'base64');
  const { commitOid, blobOid } = ctx.forge.putContent(repo, branch, path, data, body.message);
  return {
    status,
    body: {
      content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: data.length, encoding: 'base64' },
      commit: { sha: commitOid },
    },
  };
}

function contentsDelete(ctx: Ctx, repo: Repo, path: string): RestReply {
  const body = ctx.body ?? {};
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const tip = repo.branchTip(branch);
  if (!tip) return NOT_FOUND;
  const existing = repo.readPath(tip, path);
  if (!existing || existing.kind !== 'file') return NOT_FOUND;
  if (typeof body.sha === 'string' && body.sha !== existing.oid) return message(409, 'the sha does not match the current blob');
  const commitOid = ctx.forge.deleteContent(repo, branch, path, typeof body.message === 'string' ? body.message : `Delete ${path}`);
  return { status: 200, body: { content: null, commit: { sha: commitOid } } };
}

function issuesList(ctx: Ctx, repo: Repo): RestReply {
  const state = ctx.query.get('state') ?? 'open';
  const direction = ctx.query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
  issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  const { page, headers } = paginate(ctx, issues);
  return { status: 200, body: page.map((issue) => issueJson(repo, issue)), headers };
}

function issueCreate(ctx: Ctx, repo: Repo): RestReply {
  const body = ctx.body ?? {};
  if (typeof body.title !== 'string' || body.title === '') return message(422, 'title is required');
  const labels = labelNames(body);
  for (const name of labels) {
    if (!repo.labels.has(name)) return message(422, `label "${name}" does not exist`);
  }
  const issue = ctx.forge.newIssue(repo, body.title, typeof body.body === 'string' ? body.body : '', labels);
  return { status: 201, body: issueJson(repo, issue) };
}

function pullsList(ctx: Ctx, repo: Repo): RestReply {
  const state = ctx.query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
  pulls.sort((a, b) => b.seq - a.seq);
  const { page, headers } = paginate(ctx, pulls);
  return { status: 200, body: page.map((pull) => pullJson(repo, pull)), headers };
}

function pullCreate(ctx: Ctx, repo: Repo): RestReply {
  const body = ctx.body ?? {};
  const head = typeof body.head === 'string' ? body.head : '';
  const base = typeof body.base === 'string' ? body.base : '';
  if (typeof body.title !== 'string' || body.title === '') return message(422, 'title is required');
  if (!repo.refs.has(`refs/heads/${head}`)) return message(422, `head branch "${head}" does not exist`);
  if (!repo.refs.has(`refs/heads/${base}`)) return message(422, `base branch "${base}" does not exist`);
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) {
      return message(422, 'a pull request already exists for this head and base');
    }
  }
  const pull = ctx.forge.newPull(repo, body.title, typeof body.body === 'string' ? body.body : '', head, base);
  return { status: 201, body: pullJson(repo, pull) };
}

export interface ChangedFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

/** The files a pull request changes (head tree vs the merge-base tree). */
export function pullChangedFiles(repo: Repo, pull: PullRecord): ChangedFile[] {
  const baseTip = repo.branchTip(pull.baseRef);
  const headTip = repo.branchTip(pull.headRef);
  if (!baseTip || !headTip) return [];
  const base = repo.mergeBase(baseTip, headTip) ?? baseTip;
  const baseFiles = repo.flatten(base);
  const headFiles = repo.flatten(headTip);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  const files: ChangedFile[] = [];
  const lineCounts = (oid: string | undefined): Map<string, number> => {
    const counts = new Map<string, number>();
    if (!oid) return counts;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'blob') return counts;
    for (const line of object.data.toString('utf8').split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
    return counts;
  };
  for (const path of [...paths].sort()) {
    const before = baseFiles.get(path)?.oid;
    const after = headFiles.get(path)?.oid;
    if (before === after) continue;
    const status = before === undefined ? 'added' : after === undefined ? 'removed' : 'modified';
    const oldLines = lineCounts(before);
    const newLines = lineCounts(after);
    let additions = 0;
    let deletions = 0;
    for (const [line, count] of newLines) additions += Math.max(0, count - (oldLines.get(line) ?? 0));
    for (const [line, count] of oldLines) deletions += Math.max(0, count - (newLines.get(line) ?? 0));
    files.push({ filename: path, status, additions, deletions, changes: additions + deletions });
  }
  return files;
}

function pullFiles(repo: Repo, pull: PullRecord): RestReply {
  return { status: 200, body: pullChangedFiles(repo, pull) };
}

function pullMerge(ctx: Ctx, repo: Repo, pull: PullRecord): RestReply {
  if (pull.state !== 'open' || pull.merged) return message(405, 'the pull request is not mergeable');
  const method = typeof ctx.body?.merge_method === 'string' ? ctx.body.merge_method : 'merge';
  const outcome = ctx.forge.mergePull(repo, pull, method, false);
  if (!outcome.ok) return message(405, 'the pull request has conflicts');
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = ctx.forge.nowIso();
  pull.mergeCommitSha = outcome.sha;
  return { status: 200, body: { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' } };
}

// ---------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------

/**
 * Handle one /api/v3 request. `path` is the path after the prefix ('' for the
 * root), `rawBody` the request body text (already read), `baseUrl` this
 * server's origin for pagination links.
 */
export function handleRest(
  forge: Forge,
  method: string,
  path: string,
  query: URLSearchParams,
  rawBody: string,
  baseUrl: string,
): RestReply {
  let body: Record<string, unknown> | null = null;
  if (rawBody.trim() !== '') {
    try {
      const parsed = JSON.parse(rawBody) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return message(400, 'the request body is not a JSON object');
      body = parsed as Record<string, unknown>;
    } catch {
      return message(400, 'the request body is not valid JSON');
    }
  }
  const ctx: Ctx = { forge, baseUrl, path, query, body };
  const segments = path.split('/').filter((segment) => segment !== '').map((segment) => decodeURIComponent(segment));

  // Root and account-level routes.
  if (segments.length === 0) {
    if (method !== 'GET') return message(405, 'Method Not Allowed');
    return {
      status: 200,
      body: {
        current_user_url: '/api/v3/user',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
      },
    };
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return message(405, 'Method Not Allowed');
    return { status: 200, body: { installed_version: '1.0.0', verifiable_password_authentication: false } };
  }
  if (segments[0] === 'rate_limit' && segments.length === 1) {
    if (method !== 'GET') return message(405, 'Method Not Allowed');
    const core = { limit: 5000, remaining: 4999, reset: 1893456000, used: 1 };
    return { status: 200, body: { resources: { core, search: { limit: 30, remaining: 30, reset: 1893456000, used: 0 } }, rate: core } };
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return message(405, 'Method Not Allowed');
    if (forge.viewerLogin === null) return NOT_FOUND;
    return { status: 200, body: { login: forge.viewerLogin, id: 1000, type: 'User' } };
  }
  if (segments[0] === 'users' && segments.length === 2) {
    if (method !== 'GET') return message(405, 'Method Not Allowed');
    if (forge.viewerLogin === null || segments[1] !== forge.viewerLogin) return NOT_FOUND;
    return { status: 200, body: { login: forge.viewerLogin, id: 1000, type: 'User' } };
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const repos = forge.ownRepos();
      const { page, headers } = paginate(ctx, repos);
      return { status: 200, body: page.map((repo) => repoJson(forge, repo)), headers };
    }
    if (method === 'POST') return createRepo(ctx);
    return message(405, 'Method Not Allowed');
  }

  // Repository-scoped routes.
  if (segments[0] === 'repos' && segments.length >= 3) {
    const [, owner, name, ...rest] = segments;
    const repo = forge.findRepo(owner, name);
    if (!repo) return NOT_FOUND;

    if (rest.length === 0) {
      if (method === 'GET') return { status: 200, body: repoJson(forge, repo) };
      if (method === 'PATCH') {
        if (typeof body?.description === 'string') repo.description = body.description;
        if (typeof body?.private === 'boolean') repo.isPrivate = body.private;
        return { status: 200, body: repoJson(forge, repo) };
      }
      if (method === 'DELETE') {
        forge.repos.delete(name);
        return { status: 204 };
      }
      return message(405, 'Method Not Allowed');
    }

    if (rest[0] === 'branches') {
      if (rest.length === 1) {
        if (method !== 'GET') return message(405, 'Method Not Allowed');
        const branches = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref)! } }));
        return { status: 200, body: branches };
      }
      if (method !== 'GET') return message(405, 'Method Not Allowed');
      const branch = rest.slice(1).join('/');
      const tip = repo.branchTip(branch);
      if (!tip) return NOT_FOUND;
      return { status: 200, body: { name: branch, commit: { sha: tip } } };
    }

    if (rest[0] === 'commits') {
      if (rest.length === 1) {
        if (method !== 'GET') return message(405, 'Method Not Allowed');
        const ref = query.get('sha') ?? repo.defaultBranch;
        const tip = resolveCommit(repo, ref);
        if (!tip) return { status: 200, body: [] };
        const rows = repo.listCommits(tip);
        const { page, headers } = paginate(ctx, rows);
        return { status: 200, body: page.map((row) => commitJson(repo, row.oid)), headers };
      }
      if (method !== 'GET') return message(405, 'Method Not Allowed');
      if (!repo.objects.has(rest[1])) return NOT_FOUND;
      return { status: 200, body: commitJson(repo, rest[1]) };
    }

    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (rest.length === 2) {
        if (method === 'POST') {
          const ref = typeof body?.ref === 'string' ? body.ref : '';
          const sha = typeof body?.sha === 'string' ? body.sha : '';
          if (!ref.startsWith('refs/') || !repo.objects.has(sha)) return message(422, 'the ref or object does not exist');
          repo.refs.set(ref, sha);
          return { status: 201, body: { ref, object: { sha, type: repo.objects.get(sha)!.type } } };
        }
        if (method === 'GET') {
          return { status: 200, body: [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha } })) };
        }
        return message(405, 'Method Not Allowed');
      }
      if (method !== 'GET') return message(405, 'Method Not Allowed');
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (!sha) return NOT_FOUND;
      return { status: 200, body: { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } } };
    }

    if (rest[0] === 'contents') {
      const contentPath = rest.slice(1).join('/');
      if (method === 'GET') return contentsGet(ctx, repo, contentPath);
      if (method === 'PUT') return contentsPut(ctx, repo, contentPath);
      if (method === 'DELETE') return contentsDelete(ctx, repo, contentPath);
      return message(405, 'Method Not Allowed');
    }

    if (rest[0] === 'labels') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const labelName = typeof body?.name === 'string' ? body.name : '';
          if (!labelName) return message(422, 'name is required');
          const color = typeof body?.color === 'string' ? body.color : '000000';
          const existing = repo.labels.get(labelName);
          if (existing) return { status: 200, body: { name: existing.name, color: existing.color } };
          repo.labels.set(labelName, { name: labelName, color });
          return { status: 201, body: { name: labelName, color } };
        }
        if (method === 'GET') return { status: 200, body: [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })) };
        return message(405, 'Method Not Allowed');
      }
      return NOT_FOUND;
    }

    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') return issuesList(ctx, repo);
        if (method === 'POST') return issueCreate(ctx, repo);
        return message(405, 'Method Not Allowed');
      }
      const number = Number(rest[1]);
      const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
      if (rest.length === 2) {
        if (!issue) return NOT_FOUND;
        if (method === 'GET') return { status: 200, body: issueJson(repo, issue) };
        if (method === 'PATCH') {
          if (body?.state === 'closed' || body?.state === 'open') issue.state = body.state;
          if (typeof body?.title === 'string') issue.title = body.title;
          if (typeof body?.body === 'string') issue.body = body.body;
          return { status: 200, body: issueJson(repo, issue) };
        }
        return message(405, 'Method Not Allowed');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        const target = issue ?? (Number.isInteger(number) ? repo.pulls.get(number) : undefined);
        if (!target) return NOT_FOUND;
        if (method === 'GET') {
          return { status: 200, body: target.comments.map((comment) => ({ id: comment.id, body: comment.body, created_at: comment.createdAt })) };
        }
        if (method === 'POST') {
          if (typeof body?.body !== 'string') return message(422, 'body is required');
          const comment = forge.addComment(target, body.body);
          return { status: 201, body: { id: comment.id, body: comment.body, created_at: comment.createdAt } };
        }
        return message(405, 'Method Not Allowed');
      }
      return NOT_FOUND;
    }

    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') return pullsList(ctx, repo);
        if (method === 'POST') return pullCreate(ctx, repo);
        return message(405, 'Method Not Allowed');
      }
      const number = Number(rest[1]);
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (!pull) return NOT_FOUND;
      if (rest.length === 2) {
        if (method === 'GET') return { status: 200, body: pullJson(repo, pull) };
        return message(405, 'Method Not Allowed');
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (method !== 'GET') return message(405, 'Method Not Allowed');
        return pullFiles(repo, pull);
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (method !== 'PUT') return message(405, 'Method Not Allowed');
        return pullMerge(ctx, repo, pull);
      }
      return NOT_FOUND;
    }

    return NOT_FOUND;
  }

  return NOT_FOUND;
}
