import { describe, it, expect } from 'vitest';
import { classifyAbi, parseArg, stringifyResult } from '../src/lib/abi-forms';
import type { Abi } from 'viem';

describe('classifyAbi', () => {
  it('splits view/pure from nonpayable/payable and drops non-functions', () => {
    const abi: Abi = [
      { type: 'constructor', inputs: [], stateMutability: 'nonpayable' },
      {
        type: 'function',
        name: 'balanceOf',
        inputs: [{ name: 'who', type: 'address' }],
        outputs: [{ type: 'uint256' }],
        stateMutability: 'view',
      },
      {
        type: 'function',
        name: 'totalSupply',
        inputs: [],
        outputs: [{ type: 'uint256' }],
        stateMutability: 'pure',
      },
      {
        type: 'function',
        name: 'transfer',
        inputs: [
          { name: 'to', type: 'address' },
          { name: 'amount', type: 'uint256' },
        ],
        outputs: [{ type: 'bool' }],
        stateMutability: 'nonpayable',
      },
      {
        type: 'function',
        name: 'deposit',
        inputs: [],
        outputs: [],
        stateMutability: 'payable',
      },
      { type: 'event', name: 'Transfer', inputs: [], anonymous: false },
      { type: 'error', name: 'Revert', inputs: [] },
      { type: 'fallback', stateMutability: 'payable' },
      { type: 'receive', stateMutability: 'payable' },
    ];

    const { reads, writes } = classifyAbi(abi);
    expect(reads.map((r) => r.name)).toEqual(['balanceOf', 'totalSupply']);
    expect(writes.map((w) => w.name)).toEqual(['transfer', 'deposit']);
  });

  it('defaults to write bucket when stateMutability is missing', () => {
    const abi: Abi = [
      {
        type: 'function',
        name: 'legacyCall',
        inputs: [],
        outputs: [],
      } as unknown as Abi[number],
    ];
    const { reads, writes } = classifyAbi(abi);
    expect(reads).toHaveLength(0);
    expect(writes.map((w) => w.name)).toEqual(['legacyCall']);
  });
});

describe('parseArg', () => {
  it('parses addresses into checksummed form', () => {
    const result = parseArg(
      'address',
      '0x5cCccb6d334197c7C4ba94E7873d0ef11381cd4e',
    );
    // EIP-55 checksum of the same address
    expect(result).toBe('0x5CcCcb6d334197c7C4ba94E7873d0ef11381CD4e');
  });

  it('rejects invalid addresses', () => {
    expect(() => parseArg('address', 'not-an-address')).toThrow(/invalid/i);
    expect(() => parseArg('address', '')).toThrow(/expected/i);
  });

  it('parses bool variants', () => {
    expect(parseArg('bool', 'true')).toBe(true);
    expect(parseArg('bool', 'FALSE')).toBe(false);
    expect(parseArg('bool', '1')).toBe(true);
    expect(parseArg('bool', '0')).toBe(false);
    expect(() => parseArg('bool', 'maybe')).toThrow();
  });

  it('parses uint/int with decimal and hex and enforces bounds', () => {
    expect(parseArg('uint256', '42')).toBe(42n);
    expect(parseArg('uint256', '0xff')).toBe(255n);
    expect(parseArg('int256', '-1')).toBe(-1n);
    // uint8 overflow
    expect(() => parseArg('uint8', '256')).toThrow(/range/);
    // negative uint
    expect(() => parseArg('uint256', '-1')).toThrow(/negative/);
    // int8 underflow
    expect(() => parseArg('int8', '-129')).toThrow(/range/);
    // invalid int
    expect(() => parseArg('uint256', 'abc')).toThrow();
  });

  it('parses bytes and bytesN', () => {
    expect(parseArg('bytes', '0xdeadbeef')).toBe('0xdeadbeef');
    expect(() => parseArg('bytes', '0xbad')).toThrow(/even-length/);
    expect(
      parseArg(
        'bytes32',
        '0x0000000000000000000000000000000000000000000000000000000000000001',
      ),
    ).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000000001',
    );
    expect(() => parseArg('bytes32', '0x1234')).toThrow(/32 bytes/);
  });

  it('passes strings through', () => {
    expect(parseArg('string', 'hello')).toBe('hello');
    expect(parseArg('string', '')).toBe('');
  });

  it('parses JSON arrays recursively with element bounds checks', () => {
    expect(parseArg('uint256[]', '[1, 2, 3]')).toEqual([1n, 2n, 3n]);
    expect(() => parseArg('uint256[3]', '[1, 2]')).toThrow(/3 elements/);
    expect(() => parseArg('uint256[]', '[1, "bad"]')).toThrow(/element 1/);
    expect(() => parseArg('uint256[]', 'not-json')).toThrow(/invalid JSON/);
  });

  it('parses tuples via components', () => {
    const components = [
      { type: 'address' },
      { type: 'uint256' },
    ] as const;
    const result = parseArg(
      'tuple',
      '["0x5cCccb6d334197c7C4ba94E7873d0ef11381cd4e", "42"]',
      components,
    );
    expect(result).toEqual([
      '0x5CcCcb6d334197c7C4ba94E7873d0ef11381CD4e',
      42n,
    ]);
  });

  it('rejects unsupported types with a readable error', () => {
    expect(() => parseArg('function', '')).toThrow(/unsupported/);
  });
});

describe('stringifyResult', () => {
  it('renders bigint as decimal', () => {
    expect(stringifyResult(12345678901234567890n)).toBe(
      '12345678901234567890',
    );
  });

  it('checksums lowercase address strings', () => {
    expect(
      stringifyResult('0x5cCccb6d334197c7C4ba94E7873d0ef11381cd4e'),
    ).toBe('0x5CcCcb6d334197c7C4ba94E7873d0ef11381CD4e');
  });

  it('renders null/undefined as empty string', () => {
    expect(stringifyResult(null)).toBe('');
    expect(stringifyResult(undefined)).toBe('');
  });

  it('renders booleans and numbers via String()', () => {
    expect(stringifyResult(true)).toBe('true');
    expect(stringifyResult(7)).toBe('7');
  });

  it('JSON-stringifies arrays with bigint replacer', () => {
    expect(stringifyResult([1n, 2n])).toBe('[\n  "1",\n  "2"\n]');
  });

  it('JSON-stringifies objects with bigint replacer', () => {
    expect(stringifyResult({ a: 1n, b: 'x' })).toBe(
      '{\n  "a": "1",\n  "b": "x"\n}',
    );
  });
});
