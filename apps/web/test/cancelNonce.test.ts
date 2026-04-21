import { describe, it, expect } from 'vitest';
import { splitPermit2Nonce } from '../src/lib/trading/cancelNonce';

describe('splitPermit2Nonce', () => {
  it('splits nonce 0 into (0, 1)', () => {
    expect(splitPermit2Nonce(0n)).toEqual({ wordPos: 0n, mask: 1n });
  });

  it('splits bitPos inside first word', () => {
    expect(splitPermit2Nonce(5n)).toEqual({ wordPos: 0n, mask: 1n << 5n });
    expect(splitPermit2Nonce(255n)).toEqual({ wordPos: 0n, mask: 1n << 255n });
  });

  it('rolls over to wordPos=1 at nonce 256', () => {
    expect(splitPermit2Nonce(256n)).toEqual({ wordPos: 1n, mask: 1n });
    expect(splitPermit2Nonce(257n)).toEqual({ wordPos: 1n, mask: 2n });
  });

  it('accepts decimal strings', () => {
    expect(splitPermit2Nonce('256')).toEqual({ wordPos: 1n, mask: 1n });
  });

  it('accepts 0x-prefixed hex strings', () => {
    expect(splitPermit2Nonce('0x100')).toEqual({ wordPos: 1n, mask: 1n });
  });

  it('handles large 256-bit nonces', () => {
    const n = (1n << 200n) + 7n;
    const { wordPos, mask } = splitPermit2Nonce(n);
    expect(wordPos).toBe(n >> 8n);
    expect(mask).toBe(1n << (n & 0xffn));
  });

  it('rejects negative nonces', () => {
    expect(() => splitPermit2Nonce(-1n)).toThrow();
  });
});
