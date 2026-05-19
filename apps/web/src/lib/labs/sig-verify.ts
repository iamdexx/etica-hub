/**
 * Wallet-signature verification helper for EticaLabs.
 *
 * Different wallets implement `personal_sign` slightly differently:
 *
 *   - **Standard EIP-191** (MetaMask, Rabby, Frame, hardware wallets,
 *     WalletConnect): prepends `\x19Ethereum Signed Message:\n<len><msg>`
 *     before keccak256. This is what `viem.verifyMessage` expects.
 *
 *   - **Raw keccak256** (some chain-native mobile wallets, including
 *     the "etica Wallet" mobile app on chain 61803): signs the raw
 *     keccak256 of the message bytes with no EIP-191 prefix.
 *
 * To keep wallet-gated EticaLabs paths (autopilot submit, goal submit,
 * flag, vouch, operator actions) usable from every wallet on Etica, we
 * accept either signing convention: try EIP-191 first, fall back to
 * raw-keccak256. The signed *message* is identical and the
 * EIP-712-style canonical envelope (`voteMessage` /
 * `buildSubmitMessage`) is identical, so this is purely a
 * pre-hashing-prefix relaxation; the signed semantics are unchanged.
 *
 * Both verification paths use ECDSA over secp256k1 and recover an
 * address from the supplied signature. We then check the recovered
 * address against the claimed wallet with case-insensitive compare on
 * the checksummed hex.
 */
import {
  getAddress,
  hashMessage,
  keccak256,
  recoverAddress,
  toBytes,
  type Address,
  type Hex,
} from 'viem';

export interface VerifyMessageInput {
  message: string;
  signature: string;
  expected: Address;
}

export interface VerifyMessageResult {
  /** True if either EIP-191 or raw-keccak recovery matched `expected`. */
  ok: boolean;
  /**
   * Address recovered via the EIP-191 path. May be undefined if the
   * signature was malformed and recovery threw.
   */
  recoveredEip191?: Address;
  /**
   * Address recovered via the raw-keccak256 path. May be undefined if
   * the signature was malformed and recovery threw.
   */
  recoveredRawKeccak?: Address;
  /**
   * Which verification path matched, if any. Useful for logging /
   * debugging wallet compatibility.
   */
  matched?: 'eip191' | 'raw-keccak';
}

/**
 * Verifies a wallet signature against a message using both the
 * standard EIP-191 path and a raw-keccak256 fallback. Either match is
 * accepted; the canonical message envelope is identical in both cases
 * so there is no replay or message-substitution surface introduced by
 * the second path.
 */
export async function verifyEticaMessage(
  input: VerifyMessageInput,
): Promise<VerifyMessageResult> {
  const expected = sameAddress(input.expected) ? getAddress(input.expected) : input.expected;
  const signature = input.signature as Hex;

  const result: VerifyMessageResult = { ok: false };

  // Path 1: standard EIP-191 personal_sign. This is what
  // viem.verifyMessage uses internally; we call recoverAddress with
  // hashMessage so we can also return the recovered address.
  try {
    const recovered = await recoverAddress({
      hash: hashMessage(input.message),
      signature,
    });
    result.recoveredEip191 = recovered;
    if (eq(recovered, expected)) {
      result.ok = true;
      result.matched = 'eip191';
      return result;
    }
  } catch {
    // fall through to raw-keccak
  }

  // Path 2: raw keccak256 of the message bytes, no EIP-191 prefix.
  // Some chain-native mobile wallets (including the etica wallet on
  // chain 61803) sign this way.
  try {
    const recovered = await recoverAddress({
      hash: keccak256(toBytes(input.message)),
      signature,
    });
    result.recoveredRawKeccak = recovered;
    if (eq(recovered, expected)) {
      result.ok = true;
      result.matched = 'raw-keccak';
      return result;
    }
  } catch {
    // both paths failed
  }

  return result;
}

function eq(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function sameAddress(a: string): a is Address {
  return /^0x[0-9a-fA-F]{40}$/.test(a);
}
