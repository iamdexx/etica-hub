import { describe, expect, it } from 'vitest';
import { decodeTransfer, TRANSFER_TOPIC0, ZERO } from '../src/decode.js';

const A = `0x${'11'.repeat(20)}`;
const B = `0x${'22'.repeat(20)}`;
const pad = (a: string) => `0x${a.slice(2).padStart(64, '0')}` as `0x${string}`;
const base = {
  address: '0xToKeN0000000000000000000000000000000000AB' as `0x${string}`,
  logIndex: 3,
  transactionHash: '0xABC' as `0x${string}`,
};

describe('decodeTransfer', () => {
  it('decodes ERC-20 transfers with lowercase addresses and bigint value', () => {
    const row = decodeTransfer({
      ...base,
      topics: [TRANSFER_TOPIC0, pad(A), pad(B)],
      data: pad('0x' + (10n ** 18n).toString(16)),
    });
    expect(row).toEqual({
      logIndex: 3,
      tx: '0xabc',
      token: base.address.toLowerCase(),
      from: A,
      to: B,
      value: 10n ** 18n,
      tokenId: null,
    });
  });
  it('decodes ERC-721 transfers (4 topics, empty data) with tokenId and value 1', () => {
    const row = decodeTransfer({
      ...base,
      topics: [TRANSFER_TOPIC0, pad(ZERO), pad(B), pad('0x2a')],
      data: '0x',
    });
    expect(row?.tokenId).toBe(42n);
    expect(row?.value).toBe(1n);
    expect(row?.from).toBe(ZERO);
  });
  it('ignores other topics, wrong arity and non-32-byte data', () => {
    expect(
      decodeTransfer({
        ...base,
        topics: [`0x${'ab'.repeat(32)}`, pad(A), pad(B)],
        data: pad('0x1'),
      }),
    ).toBeNull();
    expect(
      decodeTransfer({ ...base, topics: [TRANSFER_TOPIC0, pad(A)], data: pad('0x1') }),
    ).toBeNull();
    expect(
      decodeTransfer({ ...base, topics: [TRANSFER_TOPIC0, pad(A), pad(B)], data: '0x1234' }),
    ).toBeNull();
  });
});
