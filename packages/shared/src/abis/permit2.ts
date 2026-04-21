/**
 * Minimal Permit2 ABI used by the UI.
 *
 * Only the surface the EticaHub frontend actually calls or reads:
 *   - `invalidateUnorderedNonces(wordPos, mask)` — user-initiated cancel of a
 *     signed Permit2 transfer. `wordPos = nonce >> 8`, `mask = 1 << (nonce & 0xff)`.
 *     Calling this invalidates exactly the bit corresponding to `nonce` so the
 *     reactor's follow-on `permitWitnessTransferFrom` reverts (`InvalidNonce`).
 *   - `allowance(owner, token, spender)` — unused here but kept for symmetry
 *     with the canonical Permit2 ABI; callers that need it can import it.
 *
 * Full ABI lives in `packages/contracts/lib/permit2/src/SignatureTransfer.sol`.
 * The four-byte selector + argument layout has been stable since Permit2's
 * initial deploy, so this stub is binary-compatible.
 */
export const permit2Abi = [
  {
    type: 'function',
    name: 'invalidateUnorderedNonces',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'wordPos', type: 'uint256' },
      { name: 'mask', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'nonceBitmap',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'wordPos', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;
