import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = {
  zrange: vi.fn(),
  get: vi.fn(),
};

vi.mock('@/lib/labs/store', () => ({ labsStore: () => store }));

const { listExpiredUnminted } = await import('@/lib/labs/archive');

function entry(id: string, completedAt: number, minted: boolean) {
  return JSON.stringify({ id, completedAt, minted, candidates: [], references: [] });
}

beforeEach(() => {
  store.zrange.mockReset();
  store.get.mockReset();
});

describe('listExpiredUnminted', () => {
  it('pages past already-minted records instead of stalling on the oldest slots', async () => {
    // 200 minted records fill the head; the unminted ones are only
    // reachable on the second page.
    const page1 = Array.from({ length: 200 }, (_, i) => `old-${i}`);
    const page2 = ['fresh-a', 'fresh-b'];
    store.zrange.mockImplementation(async (_key: string, start: number) =>
      start === 0 ? page1 : start === 200 ? page2 : [],
    );
    store.get.mockImplementation(async (key: string) =>
      key.includes('fresh') ? entry(key.split(':').pop()!, 10, false) : entry(key, 10, true),
    );

    const out = await listExpiredUnminted(1_000, 50);
    expect(out.map((e) => e.id)).toEqual(['fresh-a', 'fresh-b']);
  });

  it('stops at the cutoff — records inside the market window are never swept', async () => {
    store.zrange.mockResolvedValueOnce(['a', 'b']).mockResolvedValue([]);
    store.get.mockImplementation(async (key: string) =>
      key.endsWith(':a') ? entry('a', 500, false) : entry('b', 5_000, false),
    );

    const out = await listExpiredUnminted(1_000, 50);
    expect(out.map((e) => e.id)).toEqual(['a']);
  });

  it('honours the requested batch size', async () => {
    store.zrange.mockResolvedValueOnce(['a', 'b', 'c']).mockResolvedValue([]);
    store.get.mockImplementation(async (key: string) => entry(key.split(':').pop()!, 10, false));

    expect(await listExpiredUnminted(1_000, 2)).toHaveLength(2);
  });
});
