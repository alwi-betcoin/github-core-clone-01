[![make.fun bounty](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![make.fun rank](https://make.fun/badge/github-core-clone-01/alwi-betcoin/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![make.fun reward](https://make.fun/badge/github-core-clone-01/alwi-betcoin/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

# github-core-clone-01 — a GitHub-compatible git forge

A single-process Node forge that serves git smart HTTP (v0 + v2), the REST v3 API, GraphQL v4 and an
MCP endpoint from one in-memory store — built for
[the make.fun github-core-clone-01 bounty](https://make.fun/bounty/github-core-clone-01).

## The starter it grew from

A runnable starting point for [the contest](https://make.fun/bounty/github-core-clone-01): the entry's
HTTP server and the lifecycle the harness drives it with. It answers two routes and a JSON 404 for
everything else, so it boots and registers but passes almost nothing: the git smart-HTTP server, the
REST v3 resources, GraphQL v4 and the MCP endpoint are the contest, and this is where you start
building them.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its
own; the flag is harmless there and makes an older local Node work too. There is nothing to install:
the program imports `node:http` and its own `app.ts` only, and the trial has no package manager and
no internet.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL`
(`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; read it with
   `server.address().port`. Never bind 8080: that is the env's port, and on the one-pod layout it is
   on the same loopback.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as JSON. The
   env records the address the request came from plus that port as your base URL and dials it from
   then on. The first register wins: a later one is answered `409` and does not move the base URL.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers at once with `{"done":false}` while the
   suite runs and `{"done":true}` once its export is written. Poll it with a short backoff; never
   hold a request open, and never exit before it says `true`.
4. **Exit 0** when it does. Closing the server first is tidy; the harness stops the env afterwards,
   and the env's export is what the scorer reads.

A failed poll or register is retried with a short exponential backoff. If `MAKEFUN_ENV_URL` is unset
there is nothing to talk to, so `main.ts` exits 1 at once.

## The surface the contest scores

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe, called twice |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: initialize, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

The env presents every API call with `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (the same token is
in your environment); `/healthz` is the boot probe and takes none. Whether a missing or a wrong token
is refused is part of the protocol checks, not of this starter.

The score is `feature + agent + perf` (0..1000): the conformance checks over that surface, the MCP
checks again as the agent-native column, and four timed workloads. The version of the suite the trial
runs is in the kit under `program/`, so you can grade the same checks locally before you submit.

## Rules and limits

The rules, the scoring weights, the deadline and the prizes are on the contest page:
**https://make.fun/bounty/github-core-clone-01** (its Rules section). In short: Node 22 only, no
dependencies at run time, no internet and no `git` binary in the trial; your repository is mounted
read-only at `/bot` and you may write under `/tmp` only. The env at `MAKEFUN_ENV_URL` is the service
you answer; the model gateway, if your entry calls a model, is the only other endpoint it can reach.
The trial's CPU, memory and process limits are the rules'; its wall budget is 900 seconds.

## Layout

- `main.ts`: the lifecycle above. Keep it as it is.
- `app.ts`: the server. This is the file to grow.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): the entry's metadata and licence.

The starter is MIT licensed; a submitted entry must carry an OSI-approved licence of its own.

## The forge (app.ts and its modules)

The starter's skeleton grew into a complete in-memory forge. `main.ts` is
untouched; `app.ts` routes, and every surface reads and writes one shared
store, so an object created over any surface is the same object on all of
them:

- `forge.ts` — state: the token's viewer, the repository registry, and per
  repo the git objects, refs, labels, issues and pull requests, plus the
  contents writes and the three-way pull-request merge. Ids come from
  counters and timestamps from a logical clock (a fixed epoch plus a tick
  per mutation), so identical request sequences produce identical state.
- `gitcore.ts` — the git object model in-process (there is no git binary at
  runtime): SHA-1 ids, tree/commit/tag codecs, packfile reading with
  OFS/REF delta resolution, packfile writing, and pkt-line framing.
- `githttp.ts` — git smart HTTP: v0 and v2 ref advertisement, v2 ls-refs,
  fetch with want/have negotiation, shallow clones and deepening, and
  receive-pack with per-ref report-status (a non-fast-forward update is
  refused `ng <ref> non-fast-forward` and changes nothing).
- `rest.ts` — REST v3 under `/api/v3`: repositories, branches, commits,
  contents, labels, issues, comments and pull requests, with GitHub's
  status codes, error bodies, `X-GitHub-Request-Id` and Link pagination.
- `graphql.ts` — a hand-rolled GraphQL executor for the documents gh and
  github-mcp-server send: viewer/repository reads, issue and pull-request
  connections with cursor pagination, the create/close/merge mutations,
  Relay `node(id:)` with opaque stable global ids, batched operations, and
  the `__type` introspection probes.
- `mcp.ts` — the MCP endpoint at `/mcp`: `server/discover` (2026-07-28)
  and the legacy `initialize` handshake, `tools/list`, and the six
  github-mcp-server tools (`create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`) over the
  same store.

Authentication is one rule everywhere: `Authorization: Bearer <token>`
matching the token in the process's `MAKEFUN_SHOP_TOKEN`; anything else is
a 401. A repository belongs to the token's login — the same name under
another owner is a 404, never a 403.
