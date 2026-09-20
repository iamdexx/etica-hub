import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEsmAtlasEngine } from '../src/lib/labs/engines/esmatlas';

const PDB = [
  'HEADER                                            18-OCT-22',
  'TITLE     ESMFOLD V1 PREDICTION FOR INPUT',
  'ATOM      1  N   MET A   1      -1.000   2.000   3.000  1.00  0.61           N',
  'END',
].join('\n');

const ORIG_FETCH = globalThis.fetch;

function stubFetch(responses: Array<{ status: number; body: string } | Error>): string[] {
  const bodies: string[] = [];
  let i = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(String(init?.body));
    const next = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    if (next instanceof Error) throw next;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => next.body,
    } as Response;
  }) as typeof fetch;
  return bodies;
}

describe('ESM Atlas fold engine', () => {
  afterEach(() => {
    globalThis.fetch = ORIG_FETCH;
    vi.useRealTimers();
  });

  it('is always configured and posts the bare sequence', async () => {
    const bodies = stubFetch([{ status: 200, body: PDB }]);
    const engine = createEsmAtlasEngine();
    expect(engine.descriptor.isConfigured).toBe(true);
    expect(engine.descriptor.id).toBe('esmatlas');

    const out = await engine.fold('MKIEEG');
    expect(out).toEqual({ ok: true, pdb: PDB });
    expect(bodies).toEqual(['MKIEEG']);
  });

  it('rejects over-length sequences without a network call', async () => {
    const bodies = stubFetch([{ status: 200, body: PDB }]);
    const out = await createEsmAtlasEngine().fold('A'.repeat(401));
    expect(out.ok).toBe(false);
    expect(bodies).toHaveLength(0);
  });

  it('does not accept a 200 that is not a PDB', async () => {
    stubFetch([{ status: 200, body: '<html>maintenance</html>' }]);
    const out = await createEsmAtlasEngine().fold('MKIEEG');
    expect(out.ok).toBe(false);
  });

  it('retries transient failures then succeeds', async () => {
    vi.useFakeTimers();
    const bodies = stubFetch([
      new Error('ECONNRESET'),
      { status: 503, body: 'busy' },
      { status: 200, body: PDB },
    ]);
    const pending = createEsmAtlasEngine().fold('MKIEEG');
    await vi.runAllTimersAsync();
    const out = await pending;
    expect(out).toEqual({ ok: true, pdb: PDB });
    expect(bodies).toHaveLength(3);
  });

  it('does not retry a non-retryable status', async () => {
    const bodies = stubFetch([{ status: 400, body: 'bad sequence' }]);
    const out = await createEsmAtlasEngine().fold('MKIEEG');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain('400');
    expect(bodies).toHaveLength(1);
  });
});
