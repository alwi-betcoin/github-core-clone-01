// graphql.ts — a hand-rolled GraphQL executor for the documents gh and
// github-mcp-server send: viewer, repository reads, issue/pull connections
// with cursor pagination, the five mutations, Relay node(id:) and the
// __type introspection probes. It executes over the same forge store as the
// REST and git surfaces, so ids and objects agree across all of them.

import type { Forge, IssueRecord, PullRecord, Repo } from './forge.ts';
import { pullChangedFiles } from './rest.ts';

// ---------------------------------------------------------------------------
// global ids
// ---------------------------------------------------------------------------

function gid(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

function parseGid(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

export function repoGid(repo: Repo): string {
  return gid('Repository', repo.dbId);
}
export function issueGid(repo: Repo, issue: IssueRecord): string {
  return gid('Issue', repo.dbId, issue.number);
}
export function pullGid(repo: Repo, pull: PullRecord): string {
  return gid('PullRequest', repo.dbId, pull.number);
}

// ---------------------------------------------------------------------------
// schema surface (also what __type reports)
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'rateLimit', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate',
    'createdAt', 'updatedAt', 'url',
  ],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'author', 'repository', 'comments', 'labels',
    'createdAt', 'updatedAt', 'url',
  ],
  PullRequest: [
    'id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files',
    'body', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit', 'url',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  IssueCommentEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name', 'prefix', 'target'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId', 'subject'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

// ---------------------------------------------------------------------------
// lexer + parser for the document subset the clients send
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'scalar'; value: string | number | boolean | null; isEnum: boolean }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Map<string, ValueNode> };

interface FieldNode {
  name: string;
  alias: string | null;
  args: Map<string, ValueNode>;
  selection: SelectionItem[] | null;
}

type SelectionItem =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inlineFragment'; typeCondition: string; selection: SelectionItem[] };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selection: SelectionItem[];
}

function tokenize(source: string): Array<{ kind: string; value: string }> {
  const tokens: Array<{ kind: string; value: string }> = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j])) j += 1;
      tokens.push({ kind: 'number', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in the GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class Parser {
  private tokens: Array<{ kind: string; value: string }>;
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): { kind: string; value: string } {
    return this.tokens[this.pos];
  }

  private next(): { kind: string; value: string } {
    return this.tokens[this.pos++];
  }

  private expect(kind: string, value?: string): string {
    const token = this.next();
    if (token.kind !== kind || (value !== undefined && token.value !== value)) {
      throw new Error(`expected ${value ?? kind}, found ${token.value || token.kind}`);
    }
    return token.value;
  }

  private skipType(): void {
    if (this.peek().value === '[') {
      this.next();
      this.skipType();
      this.expect('punct', ']');
    } else {
      this.expect('name');
    }
    if (this.peek().value === '!') this.next();
  }

  private parseValue(): ValueNode {
    const token = this.peek();
    if (token.value === '$') {
      this.next();
      return { kind: 'var', name: this.expect('name') };
    }
    if (token.kind === 'string') {
      this.next();
      return { kind: 'scalar', value: token.value, isEnum: false };
    }
    if (token.kind === 'number') {
      this.next();
      return { kind: 'scalar', value: Number(token.value), isEnum: false };
    }
    if (token.value === '[') {
      this.next();
      const items: ValueNode[] = [];
      while (this.peek().value !== ']') items.push(this.parseValue());
      this.next();
      return { kind: 'list', items };
    }
    if (token.value === '{') {
      this.next();
      const fields = new Map<string, ValueNode>();
      while (this.peek().value !== '}') {
        const name = this.expect('name');
        this.expect('punct', ':');
        fields.set(name, this.parseValue());
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      this.next();
      if (token.value === 'true') return { kind: 'scalar', value: true, isEnum: false };
      if (token.value === 'false') return { kind: 'scalar', value: false, isEnum: false };
      if (token.value === 'null') return { kind: 'scalar', value: null, isEnum: false };
      return { kind: 'scalar', value: token.value, isEnum: true };
    }
    throw new Error(`unexpected value token ${token.value || token.kind}`);
  }

  private parseArgs(): Map<string, ValueNode> {
    const args = new Map<string, ValueNode>();
    if (this.peek().value !== '(') return args;
    this.next();
    while (this.peek().value !== ')') {
      const name = this.expect('name');
      this.expect('punct', ':');
      args.set(name, this.parseValue());
    }
    this.next();
    return args;
  }

  private parseSelectionSet(): SelectionItem[] {
    this.expect('punct', '{');
    const items: SelectionItem[] = [];
    while (this.peek().value !== '}') {
      if (this.peek().kind === 'spread') {
        this.next();
        const on = this.expect('name');
        if (on !== 'on') throw new Error('named fragment spreads are not supported');
        const typeCondition = this.expect('name');
        items.push({ kind: 'inlineFragment', typeCondition, selection: this.parseSelectionSet() });
        continue;
      }
      let name = this.expect('name');
      let alias: string | null = null;
      if (this.peek().value === ':') {
        this.next();
        alias = name;
        name = this.expect('name');
      }
      const args = this.parseArgs();
      const selection = this.peek().value === '{' ? this.parseSelectionSet() : null;
      items.push({ kind: 'field', field: { name, alias, args, selection } });
    }
    this.next();
    return items;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.peek().kind !== 'eof') {
      if (this.peek().value === '{') {
        operations.push({ type: 'query', name: null, selection: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expect('name');
      if (keyword === 'fragment') {
        // Skip a fragment definition (the clients inline theirs, but be safe).
        this.expect('name');
        this.expect('name'); // 'on'
        this.expect('name'); // type condition
        this.parseSelectionSet();
        continue;
      }
      if (keyword !== 'query' && keyword !== 'mutation') throw new Error(`unexpected definition ${keyword}`);
      let name: string | null = null;
      if (this.peek().kind === 'name') name = this.next().value;
      if (this.peek().value === '(') {
        // Variable definitions: skip names, types and defaults.
        this.next();
        while (this.peek().value !== ')') {
          this.expect('punct', '$');
          this.expect('name');
          this.expect('punct', ':');
          this.skipType();
          if (this.peek().value === '=') {
            this.next();
            this.parseValue();
          }
        }
        this.next();
      }
      operations.push({ type: keyword, name, selection: this.parseSelectionSet() });
    }
    return operations;
  }
}

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

type Wrapped = { __type: string; [key: string]: unknown };

interface ExecCtx {
  forge: Forge;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function evalValue(node: ValueNode, ctx: ExecCtx): unknown {
  switch (node.kind) {
    case 'var':
      return ctx.variables[node.name] ?? null;
    case 'scalar':
      return node.value;
    case 'list':
      return node.items.map((item) => evalValue(item, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of node.fields) out[key] = evalValue(value, ctx);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of field.args) out[key] = evalValue(value, ctx);
  return out;
}

function userValue(login: string): Wrapped {
  return { __type: 'User', login };
}

function issueValue(repo: Repo, issue: IssueRecord): Wrapped {
  return { __type: 'Issue', repo, issue };
}

function pullValue(repo: Repo, pull: PullRecord): Wrapped {
  return { __type: 'PullRequest', repo, pull };
}

function repoValue(repo: Repo): Wrapped {
  return { __type: 'Repository', repo };
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function pageInfo(nodes: Array<{ number: number }>, total: number, startIndex: number): Wrapped {
  const last = nodes[nodes.length - 1];
  return {
    __type: 'PageInfo',
    hasNextPage: startIndex + nodes.length < total,
    hasPreviousPage: startIndex > 0,
    startCursor: nodes.length ? cursorFor(nodes[0].number) : null,
    endCursor: last ? cursorFor(last.number) : null,
  };
}

function resolveRepoByGid(forge: Forge, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGid(id);
  if (!parsed || parsed.kind !== 'Repository') return null;
  return forge.repoByDbId(Number(parsed.parts[0]));
}

function resolveIssueByGid(forge: Forge, id: unknown): { repo: Repo; issue: IssueRecord } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGid(id);
  if (!parsed || parsed.kind !== 'Issue') return null;
  const repo = forge.repoByDbId(Number(parsed.parts[0]));
  const issue = repo?.issues.get(Number(parsed.parts[1]));
  return repo && issue ? { repo, issue } : null;
}

function resolvePullByGid(forge: Forge, id: unknown): { repo: Repo; pull: PullRecord } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGid(id);
  if (!parsed || parsed.kind !== 'PullRequest') return null;
  const repo = forge.repoByDbId(Number(parsed.parts[0]));
  const pull = repo?.pulls.get(Number(parsed.parts[1]));
  return repo && pull ? { repo, pull } : null;
}

/** Resolve one field on one wrapped object (or the root types). */
function resolveField(typeName: string, source: Wrapped | null, field: FieldNode, ctx: ExecCtx): unknown {
  const forge = ctx.forge;
  const args = argsOf(field, ctx);
  const name = field.name;

  if (typeName === 'Query') {
    if (name === 'viewer') return forge.viewerLogin === null ? null : userValue(forge.viewerLogin);
    if (name === 'repository') {
      const repo = forge.findRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo ? repoValue(repo) : null;
    }
    if (name === 'node') {
      const parsed = typeof args.id === 'string' ? parseGid(args.id) : null;
      if (!parsed) return null;
      if (parsed.kind === 'Repository') {
        const repo = forge.repoByDbId(Number(parsed.parts[0]));
        return repo ? repoValue(repo) : null;
      }
      if (parsed.kind === 'Issue') {
        const found = resolveIssueByGid(forge, args.id);
        return found ? issueValue(found.repo, found.issue) : null;
      }
      if (parsed.kind === 'PullRequest') {
        const found = resolvePullByGid(forge, args.id);
        return found ? pullValue(found.repo, found.pull) : null;
      }
      return null;
    }
    if (name === '__type') {
      const typeNameArg = String(args.name ?? '');
      if (TYPE_FIELDS[typeNameArg] || ENUM_VALUES[typeNameArg]) return { __type: '__Type', name: typeNameArg };
      return null;
    }
    if (name === 'rateLimit') return { __type: 'User', login: forge.viewerLogin ?? '' };
  }

  if (typeName === 'Mutation') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    if (name === 'createIssue') {
      const repo = resolveRepoByGid(forge, input.repositoryId);
      if (!repo) throw new Error('createIssue: the repository id does not resolve');
      const issue = forge.newIssue(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
      return { __type: 'CreateIssuePayload', issue: issueValue(repo, issue), repo };
    }
    if (name === 'closeIssue') {
      const found = resolveIssueByGid(forge, input.issueId);
      if (!found) throw new Error('closeIssue: the issue id does not resolve');
      found.issue.state = 'closed';
      return { __type: 'CloseIssuePayload', issue: issueValue(found.repo, found.issue), repo: found.repo };
    }
    if (name === 'createPullRequest') {
      const repo = resolveRepoByGid(forge, input.repositoryId);
      if (!repo) throw new Error('createPullRequest: the repository id does not resolve');
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      if (!repo.refs.has(`refs/heads/${head}`)) throw new Error(`createPullRequest: head branch "${head}" does not exist`);
      if (!repo.refs.has(`refs/heads/${base}`)) throw new Error(`createPullRequest: base branch "${base}" does not exist`);
      const pull = forge.newPull(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', head, base);
      return { __type: 'CreatePullRequestPayload', pullRequest: pullValue(repo, pull), repo };
    }
    if (name === 'mergePullRequest') {
      const found = resolvePullByGid(forge, input.pullRequestId);
      if (!found) throw new Error('mergePullRequest: the pull request id does not resolve');
      const method = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'squash';
      const outcome = forge.mergePull(found.repo, found.pull, method, false);
      if (!outcome.ok) throw new Error('mergePullRequest: the pull request is not mergeable');
      found.pull.merged = true;
      found.pull.state = 'closed';
      found.pull.mergedAt = forge.nowIso();
      found.pull.mergeCommitSha = outcome.sha;
      return { __type: 'MergePullRequestPayload', pullRequest: pullValue(found.repo, found.pull), repo: found.repo };
    }
    if (name === 'addComment') {
      const found = resolveIssueByGid(forge, input.subjectId);
      if (!found) throw new Error('addComment: the subject id does not resolve');
      const comment = forge.addComment(found.issue, String(input.body ?? ''));
      return {
        __type: 'AddCommentPayload',
        commentEdge: {
          __type: 'IssueCommentEdge',
          node: { __type: 'IssueComment', id: gid('IssueComment', found.repo.dbId, found.issue.number, comment.id), body: comment.body, createdAt: comment.createdAt },
          cursor: cursorFor(found.issue.number),
        },
        repo: found.repo,
      };
    }
  }

  if (source === null) return null;

  if (typeName === 'User') {
    if (name === 'login') return source.login;
    if (name === 'id') return gid('User', String(source.login));
    if (name === 'name') return source.login;
    if (name === 'email') return `${String(source.login)}@example.invalid`;
  }

  if (typeName === 'Repository') {
    const repo = source.repo as Repo;
    switch (name) {
      case 'id': return repoGid(repo);
      case 'databaseId': return repo.dbId;
      case 'name': return repo.name;
      case 'nameWithOwner': return `${repo.ownerLogin ?? forge.viewerLogin ?? ''}/${repo.name}`;
      case 'owner': return userValue(repo.ownerLogin ?? forge.viewerLogin ?? '');
      case 'defaultBranchRef': {
        const tip = repo.branchTip(repo.defaultBranch);
        return tip ? { __type: 'Ref', name: repo.defaultBranch, prefix: 'refs/heads/' } : null;
      }
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'description': return repo.description;
      case 'isPrivate': return repo.isPrivate;
      case 'createdAt': return '2025-01-01T00:00:00Z';
      case 'updatedAt': return '2025-01-01T00:00:00Z';
      case 'url': return `/${repo.ownerLogin ?? ''}/${repo.name}`;
      case 'issue': {
        const issue = repo.issues.get(Number(args.number));
        return issue ? issueValue(repo, issue) : null;
      }
      case 'issues': {
        let issues = [...repo.issues.values()];
        const states = Array.isArray(args.states) ? (args.states as string[]) : null;
        if (states && states.length) {
          const wanted = new Set(states.map((state) => String(state).toLowerCase()));
          issues = issues.filter((issue) => wanted.has(issue.state));
        }
        const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
        const descending = orderBy?.direction === 'DESC';
        issues.sort((a, b) => (descending ? b.seq - a.seq : a.seq - b.seq));
        let startIndex = 0;
        if (typeof args.after === 'string' && args.after !== '') {
          const afterNumber = numberFromCursor(args.after);
          const at = issues.findIndex((issue) => issue.number === afterNumber);
          if (at >= 0) startIndex = at + 1;
        }
        const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : issues.length;
        const nodes = issues.slice(startIndex, startIndex + first);
        return {
          __type: 'IssueConnection',
          nodes: nodes.map((issue) => issueValue(repo, issue)),
          pageInfo: pageInfo(nodes, issues.length, startIndex),
          totalCount: issues.length,
          repo,
        };
      }
      case 'pullRequest': {
        const pull = repo.pulls.get(Number(args.number));
        return pull ? pullValue(repo, pull) : null;
      }
      case 'pullRequests': {
        let pulls = [...repo.pulls.values()];
        const states = Array.isArray(args.states) ? (args.states as string[]) : null;
        if (states && states.length) {
          const wanted = new Set(states.map((state) => String(state).toUpperCase()));
          pulls = pulls.filter((pull) => wanted.has(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
        }
        pulls.sort((a, b) => b.seq - a.seq);
        const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : pulls.length;
        const nodes = pulls.slice(0, first);
        return {
          __type: 'PullRequestConnection',
          nodes: nodes.map((pull) => pullValue(repo, pull)),
          pageInfo: pageInfo(nodes, pulls.length, 0),
          totalCount: pulls.length,
          repo,
        };
      }
    }
  }

  if (typeName === 'Issue') {
    const repo = source.repo as Repo;
    const issue = source.issue as IssueRecord;
    switch (name) {
      case 'id': return issueGid(repo, issue);
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'state': return issue.state.toUpperCase();
      case 'body': return issue.body;
      case 'author': return userValue(forge.viewerLogin ?? '');
      case 'repository': return repoValue(repo);
      case 'createdAt': return issue.createdAt;
      case 'updatedAt': return issue.createdAt;
      case 'url': return `/${repo.ownerLogin ?? ''}/${repo.name}/issues/${issue.number}`;
      case 'comments': return {
        __type: 'IssueCommentConnection',
        nodes: issue.comments.map((comment) => ({
          __type: 'IssueComment',
          id: gid('IssueComment', repo.dbId, issue.number, comment.id),
          body: comment.body,
          createdAt: comment.createdAt,
        })),
        totalCount: issue.comments.length,
      };
      case 'labels': return { __type: 'IssueCommentConnection', nodes: [], totalCount: 0 };
    }
  }

  if (typeName === 'PullRequest') {
    const repo = source.repo as Repo;
    const pull = source.pull as PullRecord;
    switch (name) {
      case 'id': return pullGid(repo, pull);
      case 'number': return pull.number;
      case 'title': return pull.title;
      case 'body': return pull.body;
      case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      case 'merged': return pull.merged;
      case 'headRefName': return pull.headRef;
      case 'baseRefName': return pull.baseRef;
      case 'author': return userValue(forge.viewerLogin ?? '');
      case 'createdAt': return pull.createdAt;
      case 'updatedAt': return pull.createdAt;
      case 'mergedAt': return pull.mergedAt;
      case 'mergeCommit': return pull.mergeCommitSha ? { __type: 'Ref', name: pull.mergeCommitSha } : null;
      case 'url': return `/${repo.ownerLogin ?? ''}/${repo.name}/pull/${pull.number}`;
      case 'mergeable': {
        if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
        return forge.mergePull(repo, pull, 'squash', true).ok ? 'MERGEABLE' : 'CONFLICTING';
      }
      case 'files': {
        const files = pullChangedFiles(repo, pull);
        const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : files.length;
        return {
          __type: 'PullRequestChangedFileConnection',
          nodes: files.slice(0, first).map((file) => ({
            __type: 'PullRequestChangedFile',
            path: file.filename,
            additions: file.additions,
            deletions: file.deletions,
          })),
          totalCount: files.length,
        };
      }
    }
  }

  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestChangedFileConnection' || typeName === 'IssueCommentConnection') {
    if (name === 'nodes') return source.nodes;
    if (name === 'pageInfo') return (source.pageInfo as Wrapped | undefined) ?? pageInfo([], 0, 0);
    if (name === 'totalCount') return source.totalCount;
    if (name === 'edges') {
      const nodes = (source.nodes as Wrapped[]) ?? [];
      return nodes.map((node) => ({ __type: 'IssueCommentEdge', node, cursor: cursorFor(0) }));
    }
  }

  if (typeName === 'PageInfo') {
    if (name === 'hasNextPage') return source.hasNextPage;
    if (name === 'hasPreviousPage') return source.hasPreviousPage;
    if (name === 'startCursor') return source.startCursor;
    if (name === 'endCursor') return source.endCursor;
  }

  if (typeName === 'Ref') {
    if (name === 'name') return source.name;
    if (name === 'prefix') return source.prefix;
    if (name === 'target') return null;
  }

  if (typeName === 'PullRequestChangedFile') {
    if (name === 'path') return source.path;
    if (name === 'additions') return source.additions;
    if (name === 'deletions') return source.deletions;
  }

  if (typeName === 'IssueComment') {
    if (name === 'id') return source.id;
    if (name === 'body') return source.body;
    if (name === 'createdAt') return source.createdAt;
    if (name === 'author') return userValue(forge.viewerLogin ?? '');
  }

  if (typeName === 'IssueCommentEdge') {
    if (name === 'node') return source.node;
    if (name === 'cursor') return source.cursor;
  }

  if (typeName.endsWith('Payload')) {
    if (name === 'issue') return source.issue ?? null;
    if (name === 'pullRequest') return source.pullRequest ?? null;
    if (name === 'commentEdge') return source.commentEdge ?? null;
    if (name === 'clientMutationId') return null;
    if (name === 'subject') return null;
  }

  if (typeName === '__Type') {
    const typeNameArg = String(source.name);
    if (name === 'name') return typeNameArg;
    if (name === 'kind') return ENUM_VALUES[typeNameArg] ? 'ENUM' : 'OBJECT';
    if (name === 'description') return null;
    if (name === 'fields') {
      const fields = TYPE_FIELDS[typeNameArg];
      return fields ? fields.map((fieldName) => ({ __type: '__Field', name: fieldName })) : null;
    }
    if (name === 'enumValues') {
      const values = ENUM_VALUES[typeNameArg];
      return values ? values.map((value) => ({ __type: '__EnumValue', name: value })) : null;
    }
  }

  if (typeName === '__Field' || typeName === '__EnumValue') {
    if (name === 'name') return source.name;
    if (name === 'description') return null;
  }

  return undefined;
}

/** The GraphQL type a field's value carries, for nested selection sets. */
function childType(typeName: string, fieldName: string, value: unknown): string {
  if (value === null || typeof value !== 'object') return typeName;
  const wrapped = value as Wrapped;
  if (typeof wrapped.__type === 'string') return wrapped.__type;
  return typeName;
}

function applySelection(typeName: string, value: unknown, selection: SelectionItem[] | null, ctx: ExecCtx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => applySelection(typeName, item, selection, ctx));
  if (typeof value !== 'object' || selection === null) return value;
  const wrapped = value as Wrapped;
  const effectiveType = typeof wrapped.__type === 'string' ? wrapped.__type : typeName;
  const out: Record<string, unknown> = {};
  for (const item of selection) {
    if (item.kind === 'inlineFragment') {
      if (item.typeCondition === effectiveType || item.typeCondition === 'Node') {
        const inner = applySelection(effectiveType, value, item.selection, ctx) as Record<string, unknown>;
        Object.assign(out, inner);
      }
      continue;
    }
    const field = item.field;
    const key = field.alias ?? field.name;
    const knownFields = TYPE_FIELDS[effectiveType];
    if (knownFields && !knownFields.includes(field.name) && field.name !== '__typename') {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${effectiveType}'` });
      out[key] = null;
      continue;
    }
    if (field.name === '__typename') {
      out[key] = effectiveType;
      continue;
    }
    let resolved: unknown;
    try {
      resolved = resolveField(effectiveType, wrapped, field, ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
      continue;
    }
    if (resolved === undefined) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${effectiveType}'` });
      out[key] = null;
      continue;
    }
    out[key] = field.selection ? applySelection(childType(effectiveType, field.name, resolved), resolved, field.selection, ctx) : resolved;
  }
  return out;
}

function executeOperation(forge: Forge, operation: Operation, variables: Record<string, unknown>): Record<string, unknown> {
  const ctx: ExecCtx = { forge, variables, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = applySelection(rootType, { __type: rootType }, operation.selection, ctx) as Record<string, unknown>;
  const envelope: Record<string, unknown> = { data };
  if (ctx.errors.length) envelope.errors = ctx.errors.map((error) => ({ message: error.message }));
  return envelope;
}

/**
 * Handle one POST /api/graphql body (already authenticated): a single
 * operation object or a batch array. Always HTTP 200 with a GraphQL envelope
 * for well-formed JSON; 400 for a body that is not a GraphQL request.
 */
export function handleGraphQL(forge: Forge, rawBody: string): { status: number; body: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { errors: [{ message: 'the request body is not valid JSON' }] } };
  }
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { data: null, errors: [{ message: 'the operation is not an object' }] };
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.query !== 'string') return { data: null, errors: [{ message: 'the operation has no query' }] };
    let operations: Operation[];
    try {
      operations = new Parser(record.query).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'the document did not parse' }] };
    }
    if (!operations.length) return { data: null, errors: [{ message: 'the document holds no operation' }] };
    let operation = operations[0];
    if (typeof record.operationName === 'string') {
      operation = operations.find((candidate) => candidate.name === record.operationName) ?? operation;
    }
    const variables = typeof record.variables === 'object' && record.variables !== null ? (record.variables as Record<string, unknown>) : {};
    return executeOperation(forge, operation, variables);
  };
  if (Array.isArray(parsed)) return { status: 200, body: parsed.map(runOne) };
  return { status: 200, body: runOne(parsed) };
}
