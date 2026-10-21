import { beforeEach, describe, expect, it } from 'vitest';

import {
  decodeStoredPdb,
  encodeStoredPdb,
  getPdbForSequence,
  sequenceHash,
  storePdbForSequence,
} from '@/lib/labs/archive';
import { _resetLabsStoreForTests, labsStore } from '@/lib/labs/store';

const PDB = [
  'ATOM      1  N   LYS A   1       1.000 -11.000 -14.000  1.00  0.85           N  ',
  'ATOM      2  CA  LYS A   1       1.468 -11.532 -14.302  1.00  0.85           C  ',
  'ATOM     11  CA  VAL A   2       0.681  -8.191 -12.622  1.00  0.94           C  ',
  'END',
].join('\n');

describe('stored PDB codec', () => {
  beforeEach(() => {
    delete process.env.REDIS_URL;
    delete process.env.KV_REST_API_URL;
    delete process.env.LABS_KV_REST_API_URL;
    _resetLabsStoreForTests();
  });

  it('round-trips byte for byte', () => {
    const encoded = encodeStoredPdb(PDB);
    expect(encoded.startsWith('br1:')).toBe(true);
    expect(decodeStoredPdb(encoded)).toBe(PDB);
  });

  it('passes legacy plain-text values through', () => {
    expect(decodeStoredPdb(PDB)).toBe(PDB);
  });

  it('stores compressed and reads back the Cα trace', async () => {
    await storePdbForSequence('KV', PDB);
    const raw = await labsStore().get(`labs:archive:pdb:${sequenceHash('KV')}`);
    expect(raw?.startsWith('br1:')).toBe(true);
    const pdb = await getPdbForSequence('KV');
    expect(pdb).toContain(' CA  LYS');
    expect(pdb).not.toContain(' N   LYS');
  });

  it('reads records written before compression', async () => {
    await labsStore().set(`labs:archive:pdb:${sequenceHash('KV')}`, PDB);
    expect(await getPdbForSequence('KV')).toBe(PDB);
  });
});
