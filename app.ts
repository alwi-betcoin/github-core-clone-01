// app.ts — the forge's HTTP router. main.ts owns the env lifecycle; this file
// owns the surfaces: /healthz for the env's boot check, git smart HTTP under
// /{owner}/{repo}.git, REST v3 under /api/v3, GraphQL at /api/graphql and
// MCP at /mcp, all over one shared forge store (forge.ts).
//
// Every API surface authenticates the same way: `Authorization: Bearer
// <token>`, where the token is the one the trial puts in this process's
// MAKEFUN_SHOP_TOKEN. A missing or wrong token is a 401 before any routing.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './forge.ts';
import { handleGit } from './githttp.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 256 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const forge = new Forge();
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  const authorized = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return false;
    const token = header.slice('Bearer '.length);
    if (token === '') return false;
    return expectedToken === '' || token === expectedToken;
  };

  const sendJson = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void => {
    if (status === 204 || body === undefined) {
      res.writeHead(status, { ...extra });
      res.end();
      return;
    }
    const text = `${JSON.stringify(body)}\n`;
    res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...extra });
    res.end(text);
  };

  const apiHeaders = (): Record<string, string> => {
    forge.requestSeq += 1;
    return {
      'x-github-request-id': `req-${String(forge.requestSeq).padStart(6, '0')}`,
      'x-oauth-scopes': 'repo, read:org',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '4999',
      'x-ratelimit-reset': '1893456000',
    };
  };

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
        const baseUrl = `http://${req.headers.host ?? '127.0.0.1'}`;

        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Bad credentials' }, apiHeaders());
            return;
          }
          const reply = handleRest(forge, method, path.slice('/api/v3'.length), url.searchParams, body.toString('utf8'), baseUrl);
          sendJson(res, reply.status, reply.body, { ...apiHeaders(), ...(reply.headers ?? {}) });
          return;
        }

        if (path === '/api/graphql') {
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Bad credentials' }, apiHeaders());
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' }, apiHeaders());
            return;
          }
          const reply = handleGraphQL(forge, body.toString('utf8'));
          sendJson(res, reply.status, reply.body, apiHeaders());
          return;
        }

        if (path === '/mcp') {
          if (!authorized(req)) {
            sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
            return;
          }
          const reply = handleMcp(forge, method, body.toString('utf8'));
          sendJson(res, reply.status, reply.body);
          return;
        }

        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
        if (gitMatch) {
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          const [, owner, repoName, tail = ''] = gitMatch;
          const v2 = (req.headers['git-protocol'] ?? '').includes('version=2');
          const reply = handleGit(forge, decodeURIComponent(owner), decodeURIComponent(repoName), tail, url.searchParams, method, body, v2);
          res.writeHead(reply.status, { 'content-type': reply.contentType, 'content-length': reply.body.length });
          res.end(reply.body);
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch {
        try {
          if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
          else res.end();
        } catch {
          // The socket is already gone; the server itself stays up.
        }
      }
    })();
  });
}
