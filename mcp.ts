// mcp.ts — the Model Context Protocol endpoint at /mcp (streamable HTTP,
// JSON answers). It speaks both protocol eras the suite accepts: the modern
// server/discover revision (2026-07-28) and the legacy initialize handshake.
// The six tools are github-mcp-server's, backed by the same forge store as
// the REST and GraphQL surfaces.

import type { Forge } from './forge.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function objectSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: objectSchema(
      { name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } },
      ['name'],
    ),
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: objectSchema({ owner: { type: 'string' }, repo: { type: 'string' } }, ['owner', 'repo']),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: objectSchema(
      { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } },
      ['owner', 'repo', 'title'],
    ),
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: objectSchema(
      { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } },
      ['owner', 'repo'],
    ),
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: objectSchema(
      {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
      },
      ['owner', 'repo', 'title', 'head', 'base'],
    ),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request.',
    inputSchema: objectSchema(
      { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } },
      ['owner', 'repo', 'pull_number'],
    ),
  },
];

export interface McpReply {
  status: number;
  body?: unknown;
}

function rpcError(id: unknown, code: number, message: string): McpReply {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function rpcResult(id: unknown, result: unknown): McpReply {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolError(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError: true };
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  switch (name) {
    case 'create_repo': {
      const repo = forge.createRepo(String(args.name), args.private === true, typeof args.description === 'string' ? args.description : '');
      if (!repo) return toolError(`a repository named ${String(args.name)} already exists`);
      return toolResult(repoJson(forge, repo));
    }
    case 'get_repo': {
      const repo = forge.findRepo(owner, repoName);
      if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
      return toolResult(repoJson(forge, repo));
    }
    case 'create_issue': {
      const repo = forge.findRepo(owner, repoName);
      if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
      const issue = forge.newIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
      return toolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = forge.findRepo(owner, repoName);
      if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.seq - b.seq);
      return toolResult(issues.map((issue) => issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = forge.findRepo(owner, repoName);
      if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
      const head = String(args.head);
      const base = String(args.base);
      if (!repo.refs.has(`refs/heads/${head}`)) return toolError(`head branch "${head}" does not exist`);
      if (!repo.refs.has(`refs/heads/${base}`)) return toolError(`base branch "${base}" does not exist`);
      const pull = forge.newPull(repo, String(args.title), typeof args.body === 'string' ? args.body : '', head, base);
      return toolResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = forge.findRepo(owner, repoName);
      if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
      const pull = repo.pulls.get(Number(args.pull_number));
      if (!pull) return toolError(`pull request ${String(args.pull_number)} not found`);
      if (pull.state !== 'open' || pull.merged) return toolError('the pull request is not mergeable');
      const outcome = forge.mergePull(repo, pull, 'squash', false);
      if (!outcome.ok) return toolError('the pull request has conflicts');
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAt = forge.nowIso();
      pull.mergeCommitSha = outcome.sha;
      return toolResult({ ...pullJson(repo, pull), merged: true });
    }
    default:
      return toolError(`unknown tool ${name}`);
  }
}

/**
 * Handle one /mcp request (authentication is the router's job). A body that
 * is not JSON answers HTTP 400 with the JSON-RPC parse error, as the
 * transport requires.
 */
export function handleMcp(forge: Forge, method: string, rawBody: string): McpReply {
  if (method === 'DELETE') return { status: 200 };
  if (method !== 'POST') return { status: 405, body: { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not found' } } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const request = parsed as Record<string, unknown>;
  const methodName = typeof request.method === 'string' ? request.method : '';
  const hasId = 'id' in request;
  const id = request.id ?? null;
  if (!hasId) return { status: 202 }; // a notification: accepted, no answer

  const params = typeof request.params === 'object' && request.params !== null ? (request.params as Record<string, unknown>) : {};
  switch (methodName) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, { protocolVersion: negotiated, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((candidate) => candidate.name === toolName);
      if (!tool) return rpcError(id, -32602, `unknown tool ${toolName}`);
      const args = typeof params.arguments === 'object' && params.arguments !== null ? (params.arguments as Record<string, unknown>) : {};
      const required = (tool.inputSchema.required as string[]) ?? [];
      const missing = required.filter((key) => args[key] === undefined || args[key] === '');
      if (missing.length) return rpcError(id, -32602, `missing required argument(s): ${missing.join(', ')}`);
      return rpcResult(id, callTool(forge, toolName, args));
    }
    default:
      return rpcError(id, -32601, `Method not found: ${methodName}`);
  }
}
