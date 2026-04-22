import { describe, expect, it } from 'vitest';
import {
  encodeEventTopics,
  encodeFunctionData,
  keccak256,
  pad,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { abis } from '@etica-hub/shared';
import { decodeCall, decodeLog, isTokenAmountArg, tokenMeta } from '../src/lib/explorerAbi';

// Deployed addresses on chain 61803. Kept inline so the test fails loudly
// if the registry rearranges them.
const ETX: Address = '0xa5A1Bc6307b0b87989B8456D4b35F88a68650044';
const WEGAZ: Address = '0x232fb2B87CAce92B2438054A7eB79B4081E3E11a';
const UNKNOWN: Address = '0x000000000000000000000000000000000000dEaD';

describe('decodeCall', () => {
  it('decodes an ERC-20 transfer call against a known token address', () => {
    const to: Address = '0x1111111111111111111111111111111111111111';
    const amount = 1_500_000n * 10n ** 12n;
    const input = encodeFunctionData({
      abi: abis.erc20Abi,
      functionName: 'transfer',
      args: [to, amount],
    });
    const decoded = decodeCall(ETX, input);
    expect(decoded).not.toBeNull();
    expect(decoded!.abiName).toBe('ERC20');
    expect(decoded!.functionName).toBe('transfer');
    expect(decoded!.args).toHaveLength(2);
    expect(decoded!.args[0].name).toBe('to');
    expect(decoded!.args[0].type).toBe('address');
    expect((decoded!.args[0].value as string).toLowerCase()).toBe(to.toLowerCase());
    expect(decoded!.args[1].name).toBe('value');
    expect(decoded!.args[1].type).toBe('uint256');
    expect(decoded!.args[1].value).toBe(amount);
  });

  it('decodes an ERC-20 transfer even when the contract address is unknown (fallback to COMMON_ABIS)', () => {
    const to: Address = '0x2222222222222222222222222222222222222222';
    const input = encodeFunctionData({
      abi: abis.erc20Abi,
      functionName: 'transfer',
      args: [to, 42n],
    });
    const decoded = decodeCall(UNKNOWN, input);
    expect(decoded).not.toBeNull();
    expect(decoded!.functionName).toBe('transfer');
  });

  it('decodes a WEGAZ deposit() call against the wrapped-native address', () => {
    const input = encodeFunctionData({
      abi: abis.wegazAbi,
      functionName: 'deposit',
      args: [],
    });
    const decoded = decodeCall(WEGAZ, input);
    expect(decoded).not.toBeNull();
    // `deposit` is shared by WEGAZ-style ABIs only; ERC-20 has no such
    // function, so even the fallback pool wouldn't misidentify this.
    expect(decoded!.functionName).toBe('deposit');
    expect(decoded!.args).toHaveLength(0);
  });

  it('returns null for plain value transfers (calldata of 0x)', () => {
    expect(decodeCall(ETX, '0x' as Hex)).toBeNull();
  });

  it('returns null for calldata that matches no known ABI', () => {
    // Selector 0xdeadbeef — not in any known ABI.
    const junk: Hex = '0xdeadbeef';
    expect(decodeCall(UNKNOWN, junk)).toBeNull();
  });
});

describe('decodeLog', () => {
  it('decodes an ERC-20 Transfer event', () => {
    const from: Address = '0x3333333333333333333333333333333333333333';
    const to: Address = '0x4444444444444444444444444444444444444444';
    const amount = 10n ** 18n;
    const topics = encodeEventTopics({
      abi: abis.erc20Abi,
      eventName: 'Transfer',
      args: { from, to },
    });
    const data = pad(toHex(amount), { size: 32 });
    const decoded = decodeLog(ETX, topics as Hex[], data);
    expect(decoded).not.toBeNull();
    expect(decoded!.abiName).toBe('ERC20');
    expect(decoded!.eventName).toBe('Transfer');
    expect(decoded!.args).toHaveLength(3);
    expect((decoded!.args[0].value as string).toLowerCase()).toBe(from.toLowerCase());
    expect((decoded!.args[1].value as string).toLowerCase()).toBe(to.toLowerCase());
    expect(decoded!.args[2].value).toBe(amount);
  });

  it('decodes a UniswapV2Pair Swap event against an unknown pair address (fallback pool)', () => {
    const sender: Address = '0x5555555555555555555555555555555555555555';
    const recipient: Address = '0x6666666666666666666666666666666666666666';
    const topics = encodeEventTopics({
      abi: abis.pairAbi,
      eventName: 'Swap',
      args: { sender, to: recipient },
    });
    // Swap has 4 uint256 non-indexed fields: amount0In, amount1In, amount0Out, amount1Out
    const data = ('0x' +
      ''.padEnd(0, '') +
      pad(toHex(100n), { size: 32 }).slice(2) +
      pad(toHex(0n), { size: 32 }).slice(2) +
      pad(toHex(0n), { size: 32 }).slice(2) +
      pad(toHex(97n), { size: 32 }).slice(2)) as Hex;
    const decoded = decodeLog(UNKNOWN, topics as Hex[], data);
    expect(decoded).not.toBeNull();
    expect(decoded!.eventName).toBe('Swap');
    expect(decoded!.args).toHaveLength(6);
    expect(decoded!.args[1].value).toBe(100n);
    expect(decoded!.args[4].value).toBe(97n);
  });

  it('returns null for a log with no topics', () => {
    expect(decodeLog(ETX, [], '0x' as Hex)).toBeNull();
  });

  it('returns null when topic0 is not any known event signature', () => {
    const junkTopic = keccak256(toHex('no-such-event()') as Hex);
    expect(decodeLog(UNKNOWN, [junkTopic], '0x' as Hex)).toBeNull();
  });

  it('returns null for log whose topic0 looks like an event signature but data is malformed', () => {
    // Real Transfer topic0 but wrong number of indexed args (should be 3 topics; we pass 1)
    const transferTopic = keccak256(toHex('Transfer(address,address,uint256)') as Hex);
    expect(decodeLog(ETX, [transferTopic], '0x' as Hex)).toBeNull();
  });
});

describe('tokenMeta + isTokenAmountArg', () => {
  it('returns decimals for ETX/WEGAZ', () => {
    expect(tokenMeta(ETX)).toEqual({ symbol: 'ETX', decimals: 18 });
    expect(tokenMeta(WEGAZ)).toEqual({ symbol: 'WEGAZ', decimals: 18 });
  });

  it('is case-insensitive for the address key', () => {
    expect(tokenMeta(ETX.toLowerCase() as Address)?.symbol).toBe('ETX');
    expect(tokenMeta(ETX.toUpperCase() as string)?.symbol).toBe('ETX');
  });

  it('returns null for unknown / zero address', () => {
    expect(tokenMeta(zeroAddress)).toBeNull();
    expect(tokenMeta(UNKNOWN)).toBeNull();
    expect(tokenMeta(null)).toBeNull();
  });

  it('flags amount-ish uint args for token-context annotation', () => {
    expect(isTokenAmountArg({ name: 'value', type: 'uint256', value: 0n })).toBe(true);
    expect(isTokenAmountArg({ name: 'amount', type: 'uint128', value: 0n })).toBe(true);
    expect(isTokenAmountArg({ name: 'wad', type: 'uint256', value: 0n })).toBe(true);
    expect(isTokenAmountArg({ name: 'amountIn', type: 'uint256', value: 0n })).toBe(true);
    expect(isTokenAmountArg({ name: 'deadline', type: 'uint256', value: 0n })).toBe(false);
    // Must be a uint* type; signed ints don't count.
    expect(isTokenAmountArg({ name: 'value', type: 'int256', value: 0n })).toBe(false);
    expect(isTokenAmountArg({ name: 'to', type: 'address', value: zeroAddress })).toBe(false);
  });
});
