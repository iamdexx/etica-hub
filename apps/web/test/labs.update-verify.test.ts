import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { ArchivedResearch } from '@/lib/labs/archive';
import type { LabsJob } from '@/lib/labs/job';

const job: LabsJob = {
  id: 'job-1',
  prompt: 'design a binder',
  status: 'running',
  iterations: 0,
  maxIterations: 3,
  createdAt: 1,
  updatedAt: 1,
  events: [],
} as unknown as LabsJob;

const queue = { get: vi.fn(), put: vi.fn() };
const archiveResearch = vi.fn();
const storePdbForSequence = vi.fn();
const getPdbForSequence = vi.fn();

vi.mock('@/lib/labs/queue', () => ({ labsQueue: () => queue }));
vi.mock('@/lib/labs/worker-auth', () => ({ requireWorkerAuth: () => ({ ok: true }) }));
vi.mock('@/lib/labs/fold-retry-queue', () => ({
  foldRetryQueue: () => ({ get: vi.fn(), schedule: vi.fn() }),
  makeFoldRetryEntryId: (a: string, b: number) => `${a}-${b}`,
  nextRetryDelayMs: () => 1,
}));
vi.mock('@/lib/labs/archive', () => ({
  archiveResearch,
  saveArchivedResearch: vi.fn(),
  getPdbForSequence,
  storePdbForSequence,
}));
vi.mock('@/lib/labs/announce', () => ({ announceDiscovery: vi.fn() }));
vi.mock('@/lib/labs/grounding', () => ({ groundArchivedResearch: vi.fn() }));

const { POST } = await import('@/app/api/labs/queue/[id]/update/route');

const SEQ_A = 'MKTAYIAKQRQISFVKSHFSRQLEERLGLIEVQAPILSRVGDGTQDNLSGAEKAVQVKVKALPDAQ';
const SEQ_B = 'GSWEELLKRAEELIKRGDPEKALEILRKALELAKKSGDPELVKKVLELLVRVAEEAGD';

function caPdb(sequence: string): string {
  return [...sequence]
    .map((_, i) => {
      const x = (Math.cos(i * 1.75) * 2.3).toFixed(3).padStart(8);
      const y = (Math.sin(i * 1.75) * 2.3).toFixed(3).padStart(8);
      const z = (i * 1.5).toFixed(3).padStart(8);
      const serial = String(i + 1).padStart(5);
      const resSeq = String(i + 1).padStart(4);
      return `ATOM  ${serial}  CA  ALA A${resSeq}    ${x}${y}${z}  1.00 85.00           C`;
    })
    .join('\n');
}

function request(body: unknown): NextRequest {
  return new NextRequest('https://eticahub.com/api/labs/queue/job-1/update', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  queue.get.mockReset().mockResolvedValue(job);
  queue.put.mockReset().mockResolvedValue(undefined);
  archiveResearch.mockReset();
  storePdbForSequence.mockReset();
  getPdbForSequence.mockReset().mockResolvedValue(null);
});

describe('labs queue update → archive verification', () => {
  it('grades candidates against the structures sent with the done update', async () => {
    const res = await POST(
      request({
        status: 'done',
        result: {
          plan: {
            hypothesis: 'h',
            approach: 'a',
            successCriteria: 's',
            risks: 'r',
            references: [],
          },
          candidates: [
            { index: 0, sequence: SEQ_A, rationale: 'r', folded: true, score: 0.8 },
            { index: 1, sequence: SEQ_B, rationale: 'r', folded: true, score: 0.7 },
          ],
          pdbBySequenceIndex: { 0: caPdb(SEQ_A), 1: caPdb(SEQ_B) },
        },
      }),
      { params: Promise.resolve({ id: 'job-1' }) },
    );
    expect(res.status).toBe(200);
    expect(storePdbForSequence).toHaveBeenCalledTimes(2);

    const archived = archiveResearch.mock.calls[0]![0] as ArchivedResearch;
    for (const c of archived.candidates) {
      const details = c.verification?.checks.map((k) => k.detail).join('\n') ?? '';
      expect(details).not.toMatch(/no coordinates stored/);
      expect(c.verification?.checks.some((k) => k.id === 'plddt')).toBe(true);
    }
    expect(archived.bestPdb).toBeTruthy();
  });

  it('falls back to the per-sequence archive when the update carries no structure', async () => {
    getPdbForSequence.mockImplementation(async (seq: string) =>
      seq === SEQ_A ? caPdb(SEQ_A) : null,
    );
    await POST(
      request({
        status: 'done',
        result: {
          plan: {
            hypothesis: 'h',
            approach: 'a',
            successCriteria: 's',
            risks: 'r',
            references: [],
          },
          candidates: [{ index: 0, sequence: SEQ_A, rationale: 'r', folded: true, score: 0.8 }],
        },
      }),
      { params: Promise.resolve({ id: 'job-1' }) },
    );
    const archived = archiveResearch.mock.calls[0]![0] as ArchivedResearch;
    expect(archived.candidates[0]!.verification?.checks.some((k) => k.id === 'plddt')).toBe(true);
  });
});
