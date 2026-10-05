import { describe, it, expect, vi } from 'vitest';
import type { Address, PublicClient, WalletClient } from 'viem';

import { loadForfeitConfig } from '../src/forfeit/config.js';
import {
  autoListTreasuryTokens,
  findSupply,
  isContractRevert,
  listingRevertReason,
} from '../src/forfeit/list.js';

const NFT = '0x4B7673665543bC1ABf13a023Ae2A04e91A4259f9' as Address;
const MARKET = '0x0000000000000000000000000000000000000AAA' as Address;
const TREASURY = '0xB2B4bC9d02970A55efF64C2D84c622c87967C19D' as Address;
const OTHER = '0x0000000000000000000000000000000000000BBB' as Address;
const KEEPER = '0xfcdd0d3d9a167092d094287e109b9315f08d05a7' as Address;

const silent = { info: () => {}, warn: () => {}, error: () => {} };

interface ChainState {
  owners: Record<number, Address>;
  listed: Set<number>;
  optedOut: Set<number>;
  approved: boolean;
  /** Single-token approvals (getApproved). */
  tokenApproved?: Set<number>;
  marketNft?: Address;
  hasAutoList?: boolean;
  /** Token ids whose ownerOf read fails at the transport, not the contract. */
  rpcDown?: Set<number>;
  /** Token ids whose listAbandoned simulation reverts with this selector. */
  reverts?: Record<number, string>;
}

/** Minimal viem-shaped fake: enough of readContract/simulateContract for the module. */
function fakeChain(state: ChainState) {
  const writes: { tokenId: bigint; hash: `0x${string}` }[] = [];
  const readContract = vi.fn(async (args: { address: Address; functionName: string; args?: readonly unknown[] }) => {
    const id = Number((args.args?.[0] as bigint | undefined) ?? 0);
    switch (args.functionName) {
      case 'ownerOf': {
        if (state.rpcDown?.has(id)) throw new Error('HTTP request failed. Status: 502 Bad Gateway');
        const owner = state.owners[id];
        if (!owner) throw new Error('reverted: ERC721NonexistentToken');
        return owner;
      }
      case 'isApprovedForAll':
        return state.approved;
      case 'getApproved':
        return state.tokenApproved?.has(id) ? MARKET : '0x0000000000000000000000000000000000000000';
      case 'nft':
        return state.marketNft ?? NFT;
      case 'abandonedPriceBps':
        if (state.hasAutoList === false) throw new Error('execution reverted');
        return 20_000n;
      case 'isListed':
        return state.listed.has(id);
      case 'autoListDisabled':
        return state.optedOut.has(id);
      case 'listings':
        return state.listed.has(id)
          ? [TREASURY, 2_000_000_000_000_000_000n, 1n]
          : ['0x0000000000000000000000000000000000000000', 0n, 0n];
      default:
        throw new Error(`unexpected read ${args.functionName}`);
    }
  });
  const simulateContract = vi.fn(async (args: { functionName: string; args: readonly [bigint] }) => {
    const id = Number(args.args[0]);
    const selector = state.reverts?.[id];
    if (selector) {
      throw new Error(`The contract function "listAbandoned" reverted with the following signature:\n${selector}`);
    }
    return { result: 2_000_000_000_000_000_000n, request: { functionName: args.functionName, args: args.args } };
  });
  const writeContract = vi.fn(async (req: { args: readonly [bigint] }) => {
    const hash = `0x${(writes.length + 1).toString(16).padStart(64, '0')}` as `0x${string}`;
    writes.push({ tokenId: req.args[0], hash });
    state.listed.add(Number(req.args[0]));
    return hash;
  });
  const waitForTransactionReceipt = vi.fn(async () => ({ status: 'success' as const }));

  const publicClient = { readContract, simulateContract, waitForTransactionReceipt } as unknown as PublicClient;
  const walletClient = { writeContract } as unknown as WalletClient;
  const account = { address: KEEPER, type: 'json-rpc' } as never;
  return { publicClient, walletClient, account, writes, readContract, writeContract };
}

const baseParams = (chain: ReturnType<typeof fakeChain>, dryRun: boolean, maxPerRun = 10) => ({
  publicClient: chain.publicClient,
  walletClient: dryRun ? null : chain.walletClient,
  account: chain.account,
  nft: NFT,
  marketplace: MARKET,
  treasury: TREASURY,
  maxPerRun,
  dryRun,
  log: silent,
});

describe('loadForfeitConfig marketplace', () => {
  it('defaults to the shared deployment and a listing cap of 10', () => {
    const cfg = loadForfeitConfig({});
    expect(cfg.maxListPerRun).toBe(10);
    expect(cfg.marketplace === null || /^0x[0-9a-fA-F]{40}$/.test(cfg.marketplace)).toBe(true);
  });

  it('can be switched off', () => {
    expect(loadForfeitConfig({ FORFEIT_MARKETPLACE_ADDRESS: 'off' }).marketplace).toBeNull();
    expect(
      loadForfeitConfig({ FORFEIT_MARKETPLACE_ADDRESS: '0x0000000000000000000000000000000000000000' }).marketplace,
    ).toBeNull();
  });

  it('rejects a malformed address or an absurd cap', () => {
    expect(() => loadForfeitConfig({ FORFEIT_MARKETPLACE_ADDRESS: 'nope' })).toThrow();
    expect(() => loadForfeitConfig({ FORFEIT_MAX_LIST_PER_RUN: '500' })).toThrow();
  });
});

describe('findSupply', () => {
  it('finds the highest sequential token id', async () => {
    const owners: Record<number, Address> = {};
    for (let i = 1; i <= 37; i++) owners[i] = OTHER;
    const chain = fakeChain({ owners, listed: new Set(), optedOut: new Set(), approved: true });
    expect(await findSupply(chain.publicClient, NFT)).toBe(37);
  });

  it('returns 0 for an empty collection', async () => {
    const chain = fakeChain({ owners: {}, listed: new Set(), optedOut: new Set(), approved: true });
    expect(await findSupply(chain.publicClient, NFT)).toBe(0);
  });

  it('throws on a transport failure instead of truncating the collection', async () => {
    const owners: Record<number, Address> = {};
    for (let i = 1; i <= 37; i++) owners[i] = OTHER;
    const chain = fakeChain({ owners, listed: new Set(), optedOut: new Set(), approved: true, rpcDown: new Set([16]) });
    await expect(findSupply(chain.publicClient, NFT)).rejects.toThrow(/ownerOf\(16\) failed/);
  });
});

describe('isContractRevert', () => {
  it('separates reverts from transport errors', () => {
    expect(isContractRevert(new Error('The contract function "ownerOf" reverted. ERC721NonexistentToken'))).toBe(true);
    expect(isContractRevert(new Error('HTTP request failed. Status: 502 Bad Gateway'))).toBe(false);
    expect(isContractRevert(new Error('The request took too long to respond. timeout'))).toBe(false);
    expect(isContractRevert(new Error('fetch failed'))).toBe(false);
  });
});

describe('autoListTreasuryTokens', () => {
  const treasuryHeld = (): Record<number, Address> => ({
    1: OTHER,
    2: OTHER,
    3: TREASURY,
    4: TREASURY,
    5: TREASURY,
    6: TREASURY,
  });

  it('lists only unlisted treasury tokens and verifies each listing on chain', async () => {
    const chain = fakeChain({
      owners: treasuryHeld(),
      listed: new Set([3]),
      optedOut: new Set([4]),
      approved: true,
    });
    const result = await autoListTreasuryTokens(baseParams(chain, false));

    expect(result.supply).toBe(6);
    expect(result.treasuryHeld).toBe(4);
    expect(result.listed).toBe(2);
    expect(result.onMarket).toBe(3);
    expect(chain.writes.map((w) => w.tokenId)).toEqual([5n, 6n]);
    expect(result.results.map((r) => [r.tokenId, r.status])).toEqual([
      ['3', 'already-listed'],
      ['4', 'opted-out'],
      ['5', 'listed'],
      ['6', 'listed'],
    ]);
    expect(result.results.find((r) => r.tokenId === '5')?.priceWei).toBe('2000000000000000000');
  });

  it('dry run simulates but never writes', async () => {
    const chain = fakeChain({ owners: treasuryHeld(), listed: new Set(), optedOut: new Set(), approved: true });
    const result = await autoListTreasuryTokens(baseParams(chain, true));
    expect(chain.writes).toHaveLength(0);
    expect(result.results.every((r) => r.status === 'would-list')).toBe(true);
    expect(result.results).toHaveLength(4);
  });

  it('skips (not errors) when the treasury has not approved the marketplace', async () => {
    const chain = fakeChain({ owners: treasuryHeld(), listed: new Set(), optedOut: new Set(), approved: false });
    const result = await autoListTreasuryTokens(baseParams(chain, false));
    expect(result.treasuryApproved).toBe(false);
    expect(result.listed).toBe(0);
    expect(result.error).toBeUndefined();
    expect(chain.writes).toHaveLength(0);
    expect(result.results.every((r) => r.status === 'skipped')).toBe(true);
  });

  it('lists a token the treasury approved individually even without setApprovalForAll', async () => {
    const chain = fakeChain({
      owners: treasuryHeld(),
      listed: new Set(),
      optedOut: new Set(),
      approved: false,
      tokenApproved: new Set([5]),
    });
    const result = await autoListTreasuryTokens(baseParams(chain, false));
    expect(result.listed).toBe(1);
    expect(chain.writes.map((w) => w.tokenId)).toEqual([5n]);
    expect(result.results.filter((r) => r.status === 'skipped')).toHaveLength(3);
  });

  it('surfaces an RPC outage as an error rather than an empty collection', async () => {
    const chain = fakeChain({
      owners: treasuryHeld(),
      listed: new Set(),
      optedOut: new Set(),
      approved: true,
      rpcDown: new Set([3]),
    });
    await expect(autoListTreasuryTokens(baseParams(chain, false))).rejects.toThrow(/ownerOf\(3\) failed/);
    expect(chain.writes).toHaveLength(0);
  });

  it('respects the per-run cap', async () => {
    const chain = fakeChain({ owners: treasuryHeld(), listed: new Set(), optedOut: new Set(), approved: true });
    const result = await autoListTreasuryTokens(baseParams(chain, false, 1));
    expect(result.listed).toBe(1);
    expect(result.results.filter((r) => r.status === 'skipped')).toHaveLength(3);
  });

  it('a reverting token does not stop the batch', async () => {
    const chain = fakeChain({
      owners: treasuryHeld(),
      listed: new Set(),
      optedOut: new Set(),
      approved: true,
      reverts: { 4: '0xfeb774c6' },
    });
    const result = await autoListTreasuryTokens(baseParams(chain, false));
    expect(result.listed).toBe(3);
    const failed = result.results.find((r) => r.tokenId === '4');
    expect(failed?.status).toBe('error');
    expect(failed?.reason).toBe('reverted: AutoListDisabled() [0xfeb774c6]');
  });

  it('refuses a marketplace that trades a different NFT', async () => {
    const chain = fakeChain({
      owners: treasuryHeld(),
      listed: new Set(),
      optedOut: new Set(),
      approved: true,
      marketNft: OTHER,
    });
    const result = await autoListTreasuryTokens(baseParams(chain, false));
    expect(result.error).toMatch(/trades/);
    expect(chain.writes).toHaveLength(0);
  });

  it('refuses a marketplace without listAbandoned', async () => {
    const chain = fakeChain({
      owners: treasuryHeld(),
      listed: new Set(),
      optedOut: new Set(),
      approved: true,
      hasAutoList: false,
    });
    const result = await autoListTreasuryTokens(baseParams(chain, false));
    expect(result.error).toMatch(/listAbandoned/);
    expect(result.unsupported).toBe(true);
    expect(chain.writes).toHaveLength(0);
  });
});

describe('listingRevertReason', () => {
  it('names marketplace custom errors', () => {
    const err = new Error('reverted with the following signature:\n0x5effcb4e');
    expect(listingRevertReason(err)).toBe('reverted: NotTreasuryOwned() [0x5effcb4e]');
  });
});
