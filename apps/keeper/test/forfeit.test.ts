import { describe, it, expect } from 'vitest';

import { loadForfeitConfig } from '../src/forfeit/config.js';
import { decodePayload, forfeitEligibility, fetchAttestations } from '../src/forfeit/run.js';

const KEY = ('0x' + '11'.repeat(32)) as `0x${string}`;
const NOW = 1_800_000_000;

function payload(overrides: Record<string, string> = {}) {
  return decodePayload({
    parentGoalTitle: 'Pancreatic Cancer — KRAS G12D switch II binder',
    sequence: 'MKTAYIAKQRQISFVKSHFSRQ',
    analysis: 'design',
    score: '7400',
    iterations: '3',
    branchGoalId: 'goal-1#0',
    submitter: '0xB2B4bC9d02970A55efF64C2D84c622c87967C19D',
    expiresAt: String(NOW + 3600),
    exclusiveUntil: String(NOW - 2),
    marketOpenUntil: String(NOW - 1),
    parentBranchGoalId: '',
    ...overrides,
  });
}

describe('loadForfeitConfig', () => {
  it('falls back to the harvest signer and RPC', () => {
    const cfg = loadForfeitConfig({
      HARVEST_PRIVATE_KEY: KEY,
      HARVEST_RPC_URL: 'https://rpc.example',
    });
    expect(cfg.privateKey).toBe(KEY);
    expect(cfg.rpcUrl).toBe('https://rpc.example');
    expect(cfg.dryRun).toBe(false);
  });

  it('defaults to dry-run when no key is present', () => {
    expect(loadForfeitConfig({}).dryRun).toBe(true);
  });

  it('rejects a non-https base url', () => {
    expect(() => loadForfeitConfig({ FORFEIT_BASE_URL: 'http://evil.example' })).toThrow();
  });

  it('rejects an out-of-range batch size', () => {
    expect(() => loadForfeitConfig({ FORFEIT_MAX_PER_RUN: '100' })).toThrow();
  });
});

describe('forfeitEligibility', () => {
  it('accepts a matured, unexpired attestation', () => {
    expect(forfeitEligibility(payload(), NOW)).toEqual({ ok: true });
  });

  it('refuses a record still in the open-market window — it would mint to the keeper', () => {
    const result = forfeitEligibility(payload({ marketOpenUntil: String(NOW + 60) }), NOW);
    expect(result).toEqual({ ok: false, reason: 'still inside the open-market window' });
  });

  it('refuses an expired attestation', () => {
    const result = forfeitEligibility(payload({ expiresAt: String(NOW - 1) }), NOW);
    expect(result.ok).toBe(false);
  });

  it('refuses an incomplete payload', () => {
    expect(forfeitEligibility(payload({ sequence: '' }), NOW).ok).toBe(false);
  });
});

describe('decodePayload', () => {
  it('rebuilds bigint fields from the JSON wire format', () => {
    const p = payload();
    expect(p.score).toBe(7400n);
    expect(p.iterations).toBe(3n);
    expect(p.marketOpenUntil).toBe(BigInt(NOW - 1));
  });
});

describe('fetchAttestations', () => {
  it('sends the batch size and bearer token, and returns the body', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: true,
        json: async () => ({ attestations: [], scanned: 0 }),
      };
    }) as unknown as typeof fetch;

    const cfg = loadForfeitConfig({ FORFEIT_WORKER_TOKEN: 'tok', FORFEIT_MAX_PER_RUN: '7' });
    await fetchAttestations(cfg, fetchImpl);

    expect(calls[0].url).toBe('https://eticahub.com/api/labs/treasury/attestations');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ max: 7 });
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('throws on a non-2xx response instead of silently sweeping nothing', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 429 })) as unknown as typeof fetch;
    await expect(fetchAttestations(loadForfeitConfig({}), fetchImpl)).rejects.toThrow('429');
  });
});
