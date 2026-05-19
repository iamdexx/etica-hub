/**
 * Shared-secret guard for worker-facing Labs Autopilot endpoints.
 *
 * The GitHub Actions worker authenticates by sending the token in the
 * `x-labs-worker-token` header. The same token is set as a Vercel env var
 * `LABS_AUTOPILOT_TOKEN`. If the env is unset, worker endpoints refuse
 * to run (fail closed) — better to block the worker than expose mutating
 * endpoints to the public internet.
 */

import { NextRequest } from 'next/server';

const HEADER_NAME = 'x-labs-worker-token';

export type WorkerAuthResult =
  | { ok: true }
  | { ok: false; status: number; body: { error: string } };

export function requireWorkerAuth(req: NextRequest): WorkerAuthResult {
  const expected = process.env.LABS_AUTOPILOT_TOKEN;
  if (!expected) {
    return {
      ok: false,
      status: 503,
      body: { error: 'LABS_AUTOPILOT_TOKEN is not configured on the server.' },
    };
  }
  const provided = req.headers.get(HEADER_NAME);
  if (!provided || provided.length !== expected.length) {
    return { ok: false, status: 401, body: { error: 'Unauthorized.' } };
  }
  // Constant-time compare so timing leaks don't help an attacker brute-force.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  if (diff !== 0) {
    return { ok: false, status: 401, body: { error: 'Unauthorized.' } };
  }
  return { ok: true };
}

export const LABS_WORKER_HEADER = HEADER_NAME;
