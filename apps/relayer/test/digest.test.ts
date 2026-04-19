import { describe, expect, it } from 'vitest';
import { hashMessage, keccak256, recoverAddress, toHex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { buildDigest, ethSignedMessageHash } from '../src/digest';

describe('buildDigest', () => {
  const base = {
    srcChainId: 61803n,
    dstChainId: 1n,
    srcTxHash: '0x1111111111111111111111111111111111111111111111111111111111111111' as const,
    nonce: '0x2222222222222222222222222222222222222222222222222222222222222222' as const,
    token: '0x34c61EA91bAcdA647269d4e310A86b875c09946f' as const,
    amount: 1_000_000_000_000_000_000_000n,
    recipient: '0xB2B4bC9d02970A55efF64C2D84c622c87967C19D' as const,
  };

  it('is deterministic', () => {
    expect(buildDigest(base)).toEqual(buildDigest(base));
  });

  it('changes when any field changes', () => {
    const d0 = buildDigest(base);
    expect(buildDigest({ ...base, srcChainId: base.srcChainId + 1n })).not.toEqual(d0);
    expect(buildDigest({ ...base, dstChainId: base.dstChainId + 1n })).not.toEqual(d0);
    expect(
      buildDigest({
        ...base,
        srcTxHash:
          '0x3333333333333333333333333333333333333333333333333333333333333333',
      }),
    ).not.toEqual(d0);
    expect(
      buildDigest({
        ...base,
        nonce: '0x4444444444444444444444444444444444444444444444444444444444444444',
      }),
    ).not.toEqual(d0);
    expect(
      buildDigest({ ...base, token: '0x0000000000000000000000000000000000000001' }),
    ).not.toEqual(d0);
    expect(buildDigest({ ...base, amount: base.amount + 1n })).not.toEqual(d0);
    expect(
      buildDigest({
        ...base,
        recipient: '0x0000000000000000000000000000000000000002',
      }),
    ).not.toEqual(d0);
  });

  it('does not equal its own EIP-191 wrapping', () => {
    const d = buildDigest(base);
    expect(d).not.toEqual(ethSignedMessageHash(d));
  });
});

describe('ethSignedMessageHash', () => {
  it('matches viem.hashMessage({raw})', () => {
    const digest = buildDigest({
      srcChainId: 1n,
      dstChainId: 61803n,
      srcTxHash: ('0xaaaa' + '0'.repeat(60)) as `0x${string}`,
      nonce: ('0xbbbb' + '0'.repeat(60)) as `0x${string}`,
      token: '0x34c61EA91bAcdA647269d4e310A86b875c09946f',
      amount: 42n,
      recipient: '0xB2B4bC9d02970A55efF64C2D84c622c87967C19D',
    });
    expect(ethSignedMessageHash(digest)).toEqual(hashMessage({ raw: digest }));
  });

  it('is keccak of literal EIP-191 prefix', () => {
    const digest = keccak256(toHex('hello'));
    const expected = keccak256(
      (toHex('\x19Ethereum Signed Message:\n32') + digest.slice(2)) as `0x${string}`,
    );
    expect(ethSignedMessageHash(digest)).toEqual(expected);
  });
});

describe('signature roundtrip', () => {
  it('viem signMessage over raw digest recovers to the signer', async () => {
    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);
    const payload = {
      srcChainId: 61803n,
      dstChainId: 1n,
      srcTxHash:
        '0xabababababababababababababababababababababababababababababababab' as const,
      nonce: '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd' as const,
      token: '0x34c61EA91bAcdA647269d4e310A86b875c09946f' as const,
      amount: 123n,
      recipient: account.address,
    };
    const digest = buildDigest(payload);
    const signature = await account.signMessage({ message: { raw: digest } });
    const recovered = await recoverAddress({
      hash: hashMessage({ raw: digest }),
      signature,
    });
    expect(recovered.toLowerCase()).toEqual(account.address.toLowerCase());
  });
});
