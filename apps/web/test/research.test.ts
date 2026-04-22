import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchIpfsText } from '../src/lib/research';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchIpfsText', () => {
  it('returns the first gateway body when it responds 2xx', async () => {
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockImplementationOnce(async () =>
        new Response('hello from dweb.link', { status: 200 }),
      );

    const out = await fetchIpfsText(
      'bafybeihkoviema7g3gxyt6la7vd5ho32ictqbilu3wnlo3rs7ewhnp7lla',
    );

    expect(out).toBe('hello from dweb.link');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('falls through to the next gateway on non-2xx / throw', async () => {
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      // dweb.link 502
      .mockImplementationOnce(async () => new Response('bad gateway', { status: 502 }))
      // ipfs.io throws (network error)
      .mockImplementationOnce(async () => {
        throw new Error('ECONNRESET');
      })
      // nftstorage.link 200
      .mockImplementationOnce(async () =>
        new Response('content from nftstorage', { status: 200 }),
      );

    const out = await fetchIpfsText(
      'bafybeihkoviema7g3gxyt6la7vd5ho32ictqbilu3wnlo3rs7ewhnp7lla',
    );

    expect(out).toBe('content from nftstorage');
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('returns undefined when every gateway fails', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      throw new Error('ENETUNREACH');
    });

    const out = await fetchIpfsText(
      'bafybeihkoviema7g3gxyt6la7vd5ho32ictqbilu3wnlo3rs7ewhnp7lla',
    );

    expect(out).toBeUndefined();
  });

  it('caps very large bodies to the render hard cap', async () => {
    const huge = 'x'.repeat(250_000);
    vi.spyOn(global, 'fetch').mockImplementationOnce(
      async () => new Response(huge, { status: 200 }),
    );

    const out = await fetchIpfsText(
      'bafybeihkoviema7g3gxyt6la7vd5ho32ictqbilu3wnlo3rs7ewhnp7lla',
    );

    expect(out?.length).toBe(200_000);
  });
});
