/**
 * Auto-listing — put treasury-held research NFTs on the marketplace.
 *
 * Abandoned research is force-minted to the treasury, an EOA with no
 * automation key, so nothing could list it for sale. The marketplace's
 * `listAbandoned(tokenId)` is permissionless: anyone may list a
 * treasury-owned token, the price is derived on-chain from the record's
 * mint fee, and the proceeds go to the treasury — so this keeper only
 * pays gas, exactly as it does for the forfeit claim itself.
 *
 * Every run walks the whole collection (token ids are sequential from 1)
 * rather than only the tokens it just settled, so a token whose listing
 * failed once, or that was settled by another keeper, is picked up later.
 * The treasury opts a token out by cancelling its listing; the marketplace
 * then refuses to auto-list it again and this keeper reports it as such.
 */

import { parseAbi, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';
import type { Account } from 'viem/accounts';

type Logger = Pick<Console, 'info' | 'warn' | 'error'>;

export const LISTING_NFT_ABI = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
]);

export const MARKETPLACE_ABI = parseAbi([
  'function nft() view returns (address)',
  'function abandonedPriceBps() view returns (uint256)',
  'function isListed(uint256 tokenId) view returns (bool)',
  'function autoListDisabled(uint256 tokenId) view returns (bool)',
  'function abandonedPriceOf(uint256 tokenId) view returns (uint128)',
  'function listAbandoned(uint256 tokenId) returns (uint128 price)',
  'function listings(uint256 tokenId) view returns (address seller, uint128 price, uint64 listedAt)',
]);

/** Custom-error selectors the marketplace reverts with, keyed by 4-byte hash. */
export const MARKETPLACE_REVERT_SELECTORS: Record<string, string> = {
  '0x30cd7471': 'NotOwner',
  '0xc19f17a9': 'NotApproved',
  '0xe528e11e': 'PriceZero',
  '0x665c1c57': 'NotListed',
  '0x5effcb4e': 'NotTreasuryOwned',
  '0xa3d582ec': 'AlreadyListed',
  '0xfeb774c6': 'AutoListDisabled',
};

export interface ListingOutcome {
  tokenId: string;
  status: 'listed' | 'would-list' | 'already-listed' | 'opted-out' | 'skipped' | 'error';
  priceWei?: string;
  txHash?: Hex;
  reason?: string;
}

export interface AutoListResult {
  /** Highest token id that exists on the NFT. */
  supply: number;
  /** Tokens the treasury owns. */
  treasuryHeld: number;
  /** Treasury tokens with an active listing after this run. */
  onMarket: number;
  listed: number;
  /** False when the treasury has not approved the marketplace; nothing is listed. */
  treasuryApproved: boolean;
  results: ListingOutcome[];
  error?: string;
}

export interface AutoListParams {
  publicClient: PublicClient;
  walletClient: WalletClient | null;
  account: Account | null;
  nft: Address;
  marketplace: Address;
  treasury: Address;
  maxPerRun: number;
  dryRun: boolean;
  log?: Logger;
  /** Upper bound on the token-id probe, so a broken RPC can't spin forever. */
  maxTokenId?: number;
}

const CHUNK = 25;

async function tokenExists(client: PublicClient, nft: Address, id: bigint): Promise<boolean> {
  try {
    await client.readContract({ address: nft, abi: LISTING_NFT_ABI, functionName: 'ownerOf', args: [id] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Token ids are minted sequentially from 1 and never burned, so
 * `ownerOf` succeeding is monotone in the id: exponential probe then
 * bisect to the highest existing id.
 */
export async function findSupply(
  client: PublicClient,
  nft: Address,
  maxTokenId = 1_000_000,
): Promise<number> {
  if (!(await tokenExists(client, nft, 1n))) return 0;
  let lo = 1n;
  let hi = 2n;
  while (hi <= BigInt(maxTokenId) && (await tokenExists(client, nft, hi))) {
    lo = hi;
    hi *= 2n;
  }
  if (hi > BigInt(maxTokenId)) hi = BigInt(maxTokenId) + 1n;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (await tokenExists(client, nft, mid)) lo = mid;
    else hi = mid;
  }
  return Number(lo);
}

async function ownersOf(client: PublicClient, nft: Address, ids: bigint[]): Promise<(Address | null)[]> {
  const out: (Address | null)[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const owners = await Promise.all(
      slice.map((id) =>
        client
          .readContract({ address: nft, abi: LISTING_NFT_ABI, functionName: 'ownerOf', args: [id] })
          .then((o) => o as Address)
          .catch(() => null),
      ),
    );
    out.push(...owners);
  }
  return out;
}

export function listingRevertReason(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const selector = text.match(/0x[0-9a-fA-F]{8}\b/)?.[0]?.toLowerCase();
  const named = selector ? MARKETPLACE_REVERT_SELECTORS[selector] : undefined;
  return named ? `reverted: ${named}() [${selector}]` : (text.split('\n')[0] ?? text);
}

export async function autoListTreasuryTokens(params: AutoListParams): Promise<AutoListResult> {
  const { publicClient, walletClient, account, nft, marketplace, treasury, maxPerRun, dryRun } = params;
  const log = params.log ?? console;
  const results: ListingOutcome[] = [];
  const empty = (error: string): AutoListResult => ({
    supply: 0,
    treasuryHeld: 0,
    onMarket: 0,
    listed: 0,
    treasuryApproved: false,
    results,
    error,
  });

  const marketNft = (await publicClient
    .readContract({ address: marketplace, abi: MARKETPLACE_ABI, functionName: 'nft' })
    .catch(() => null)) as Address | null;
  if (!marketNft) {
    const error = `marketplace ${marketplace} is not readable (wrong address or contract?)`;
    log.error(`[autolist] ${error}`);
    return empty(error);
  }
  if (marketNft.toLowerCase() !== nft.toLowerCase()) {
    const error = `marketplace ${marketplace} trades ${marketNft}, configured NFT is ${nft}`;
    log.error(`[autolist] ${error}`);
    return empty(error);
  }
  const priceBps = await publicClient
    .readContract({ address: marketplace, abi: MARKETPLACE_ABI, functionName: 'abandonedPriceBps' })
    .catch(() => null);
  if (priceBps === null) {
    const error = `marketplace ${marketplace} has no listAbandoned() — deploy the version with treasury auto-listing`;
    log.error(`[autolist] ${error}`);
    return empty(error);
  }

  const supply = await findSupply(publicClient, nft, params.maxTokenId);
  const ids = Array.from({ length: supply }, (_, i) => BigInt(i + 1));
  const owners = await ownersOf(publicClient, nft, ids);
  const held = ids.filter((_, i) => owners[i]?.toLowerCase() === treasury.toLowerCase());

  const treasuryApproved = (await publicClient.readContract({
    address: nft,
    abi: LISTING_NFT_ABI,
    functionName: 'isApprovedForAll',
    args: [treasury, marketplace],
  })) as boolean;

  let onMarket = 0;
  const candidates: bigint[] = [];
  for (let i = 0; i < held.length; i += CHUNK) {
    const slice = held.slice(i, i + CHUNK);
    const states = await Promise.all(
      slice.map(async (id) => {
        const [isListed, optedOut] = await Promise.all([
          publicClient.readContract({ address: marketplace, abi: MARKETPLACE_ABI, functionName: 'isListed', args: [id] }),
          publicClient.readContract({ address: marketplace, abi: MARKETPLACE_ABI, functionName: 'autoListDisabled', args: [id] }),
        ]);
        return { id, isListed: isListed as boolean, optedOut: optedOut as boolean };
      }),
    );
    for (const s of states) {
      if (s.isListed) {
        onMarket += 1;
        results.push({ tokenId: s.id.toString(), status: 'already-listed' });
      } else if (s.optedOut) {
        results.push({ tokenId: s.id.toString(), status: 'opted-out', reason: 'treasury cancelled this listing' });
      } else {
        candidates.push(s.id);
      }
    }
  }

  log.info(
    `[autolist] supply=${supply} treasuryHeld=${held.length} onMarket=${onMarket} ` +
      `unlisted=${candidates.length} treasuryApproved=${treasuryApproved} dryRun=${dryRun}`,
  );

  if (candidates.length > 0 && !treasuryApproved) {
    log.warn(
      `[autolist] treasury ${treasury} has not approved marketplace ${marketplace} ` +
        `(setApprovalForAll) — ${candidates.length} token(s) cannot be listed until it does. ` +
        `Connect the treasury wallet on /labs/market to grant it once.`,
    );
    for (const id of candidates) {
      results.push({ tokenId: id.toString(), status: 'skipped', reason: 'treasury has not approved the marketplace' });
    }
    return { supply, treasuryHeld: held.length, onMarket, listed: 0, treasuryApproved, results };
  }

  let listed = 0;
  const batch = candidates.slice(0, maxPerRun);
  for (const id of candidates.slice(maxPerRun)) {
    results.push({ tokenId: id.toString(), status: 'skipped', reason: 'over per-run cap' });
  }

  for (const id of batch) {
    const tokenId = id.toString();
    try {
      const sim = await publicClient.simulateContract({
        address: marketplace,
        abi: MARKETPLACE_ABI,
        functionName: 'listAbandoned',
        args: [id],
        account: account?.address ?? treasury,
      });
      const priceWei = (sim.result as bigint).toString();

      if (dryRun || !walletClient || !account) {
        results.push({ tokenId, status: 'would-list', priceWei });
        continue;
      }

      const txHash = await walletClient.writeContract({ ...sim.request, account });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') {
        results.push({ tokenId, status: 'error', txHash, reason: 'transaction reverted' });
        continue;
      }

      const [seller, price] = (await publicClient.readContract({
        address: marketplace,
        abi: MARKETPLACE_ABI,
        functionName: 'listings',
        args: [id],
      })) as readonly [Address, bigint, bigint];
      if (seller.toLowerCase() !== treasury.toLowerCase() || price === 0n) {
        results.push({
          tokenId,
          status: 'error',
          txHash,
          reason: `listing not found after tx (seller=${seller}, price=${price})`,
        });
        continue;
      }

      listed += 1;
      onMarket += 1;
      results.push({ tokenId, status: 'listed', txHash, priceWei: price.toString() });
      log.info(`[autolist] listed token ${tokenId} at ${Number(price) / 1e18} EGAZ (${txHash})`);
    } catch (err) {
      const reason = listingRevertReason(err);
      log.warn(`[autolist] token ${tokenId}: ${reason}`);
      results.push({ tokenId, status: 'error', reason });
    }
  }

  log.info(
    `[autolist] run complete — listed=${listed} onMarket=${onMarket} ` +
      `errors=${results.filter((r) => r.status === 'error').length}`,
  );

  return { supply, treasuryHeld: held.length, onMarket, listed, treasuryApproved, results };
}
