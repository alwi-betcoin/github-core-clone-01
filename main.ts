// Entry lifecycle for the forge: announce this process to the trial env, serve
// until the env ends the trial, then shut down cleanly.
//
// The env is a separate server whose origin arrives in MAKEFUN_ENV_URL. This
// file owns only the conversation with it; the forge itself lives in app.ts,
// and nothing here imports anything beyond that server.

import { createApp } from './app.ts';

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is unset: there is no env to register with\n');
  process.exit(1);
}

/** One env request may hang at most this long before it counts as failed. */
const ENV_CALL_TIMEOUT_MS = 30_000;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait after `failures` failed env calls in a row: 250 ms, doubling, capped at 2 s. */
function backoffMs(failures: number): number {
  return Math.min(2_000, 250 * 2 ** Math.min(failures, 8));
}

/**
 * One call to the env. Resolves to its response, or to null when the call itself
 * failed (the env still starting, a timeout, a refused connection): callers
 * treat null as "not yet" and retry.
 */
async function envCall(path: string, init?: RequestInit): Promise<Response | null> {
  try {
    return await fetch(`${envOrigin}${path}`, { ...init, signal: AbortSignal.timeout(ENV_CALL_TIMEOUT_MS) });
  } catch {
    return null;
  }
}

/**
 * POST the port this process bound until the env takes it. 200 registers us;
 * 409 means a first registration already won and is not ours to fix, so we move
 * on either way. 400 and 405 are contract errors and end the program. Any other
 * outcome is retried with backoff, since the env may still be starting.
 */
async function announce(port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    const res = await envCall('/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
    });
    if (res !== null) {
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    }
    await pause(backoffMs(failures));
  }
}

/** Poll GET /done until the env answers {"done": true}; never return before that. */
async function waitForDone(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    const res = await envCall('/done');
    if (res !== null && res.ok) {
      const body: unknown = await res.json().catch(() => null);
      if (body !== null && typeof body === 'object' && (body as { done?: unknown }).done === true) return;
    }
    await pause(backoffMs(failures));
  }
}

/** Bind an ephemeral port, announce it, then wait for the env: the whole life of the process. */
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[entry] serving on port ${address.port}\n`);

  await announce(address.port);
  process.stdout.write('[entry] announced; waiting for the env to finish\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] env finished; shutting down\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
