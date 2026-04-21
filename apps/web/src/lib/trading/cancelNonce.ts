/**
 * Permit2 nonce-invalidation helpers.
 *
 * Permit2's unordered-nonce model represents the full 256-bit nonce space as
 * a 2D bitmap: `nonceBitmap[owner][wordPos]` is a uint256 where each bit
 * corresponds to one nonce. A nonce `n` is encoded as:
 *
 *   wordPos = n >> 8        (which 256-bit word)
 *   bitPos  = n & 0xff       (which bit inside that word, 0..255)
 *   mask    = 1 << bitPos
 *
 * Calling `permit2.invalidateUnorderedNonces(wordPos, mask)` flips that bit
 * on-chain, which causes any future `permitWitnessTransferFrom(...)` with the
 * same `(owner, nonce)` to revert. This is how a user cancels a signed
 * UniswapX order without needing to touch the reactor at all.
 *
 * We expose the split explicitly so the UI can batch cancels later (one tx
 * invalidating up to 256 orders whose nonces share a wordPos).
 */

/**
 * Split a 256-bit nonce into the `(wordPos, mask)` pair required by
 * `Permit2.invalidateUnorderedNonces`.
 *
 * @param nonce decimal or `0x`-prefixed hex string (the UniswapX order nonce).
 *              Supports bigints directly.
 */
export function splitPermit2Nonce(nonce: bigint | string): { wordPos: bigint; mask: bigint } {
  const n = typeof nonce === 'bigint' ? nonce : BigInt(nonce);
  if (n < 0n) throw new Error('nonce must be non-negative');
  const wordPos = n >> 8n;
  const bitPos = n & 0xffn;
  const mask = 1n << bitPos;
  return { wordPos, mask };
}
