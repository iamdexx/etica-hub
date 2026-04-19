import {
  encodeAbiParameters,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from 'viem';

/**
 * Canonical attestation digest. Must mirror the on-chain implementation in
 * both `EticaBridgeVault.buildDigest` and `EthereumBridgeMinter.buildDigest`
 * — any divergence produces a signature the destination contract rejects.
 *
 * The digest binds:
 *   - `srcChainId` / `dstChainId` to stop a mainnet attestation from being
 *     replayed on testnet (or vice versa).
 *   - `srcTxHash` so the exact deposit/burn is identifiable off-chain.
 *   - `nonce` as the pre-image of the per-chain `processed` map.
 *   - `token`, `amount`, `recipient` so validators attest to the payload,
 *     not just the event.
 */
export interface AttestationPayload {
  srcChainId: bigint;
  dstChainId: bigint;
  srcTxHash: Hex;
  nonce: Hex;
  token: Address;
  amount: bigint;
  recipient: Address;
}

export function buildDigest(p: AttestationPayload): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'address' },
      ],
      [
        p.srcChainId,
        p.dstChainId,
        p.srcTxHash,
        p.nonce,
        p.token,
        p.amount,
        p.recipient,
      ],
    ),
  );
}

/**
 * Wrap a raw digest in the EIP-191 personal_sign envelope, matching the
 * `keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest))`
 * pre-image the verifier recovers against.
 *
 * Consumers who sign via a viem `account.signMessage({ raw: digest })` do
 * not need to call this — viem wraps the digest for you. It's exported
 * here so tests can recompute the wrapped hash and assert determinism.
 */
export function ethSignedMessageHash(digest: Hex): Hex {
  const prefix = toHex('\x19Ethereum Signed Message:\n32');
  return keccak256(`${prefix}${digest.slice(2)}` as Hex);
}
