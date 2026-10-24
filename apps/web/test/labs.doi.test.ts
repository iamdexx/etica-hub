import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = { get: vi.fn() };
vi.mock('@/lib/labs/store', () => ({ labsStore: () => store }));

const { getRecordDoi, parseRecordDoi } = await import('@/lib/labs/doi');

const valid = {
  doi: '10.5281/zenodo.23611145',
  url: 'https://doi.org/10.5281/zenodo.23611145',
};

describe('record DOIs', () => {
  beforeEach(() => store.get.mockReset());

  it('accepts a Zenodo DOI whose url matches', () => {
    expect(parseRecordDoi(JSON.stringify(valid))).toEqual(valid);
  });

  it('rejects anything that is not a Zenodo DOI with a matching doi.org url', () => {
    expect(parseRecordDoi(null)).toBeNull();
    expect(parseRecordDoi('{')).toBeNull();
    expect(parseRecordDoi(JSON.stringify({ ...valid, doi: '10.1000/other' }))).toBeNull();
    expect(parseRecordDoi(JSON.stringify({ ...valid, url: 'https://evil.example/x' }))).toBeNull();
  });

  it('reads labs:doi:{id} and swallows store failures', async () => {
    store.get.mockResolvedValueOnce(JSON.stringify(valid));
    expect(await getRecordDoi('abc-archive')).toEqual(valid);
    expect(store.get).toHaveBeenCalledWith('labs:doi:abc-archive');
    store.get.mockRejectedValueOnce(new Error('down'));
    expect(await getRecordDoi('abc-archive')).toBeNull();
  });
});
