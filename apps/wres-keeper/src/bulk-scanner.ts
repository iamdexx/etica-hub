/**
 * Bulk ERC-721 index scanner.
 *
 * Given any ERC-721 contract on any EVM chain, enumerates every minted tokenId
 * and returns a `Registration[]` that the keeper planner can consume. Supports
 * two strategies:
 *
 * 1. **ERC-721 Enumerable** — `totalSupply()` + `tokenByIndex(i)`. Preferred
 *    when the contract supports it (most do).
 * 2. **Transfer-event scan** — walks `Transfer(0x0, to, tokenId)` mint events
 *    from genesis. Fallback for non-enumerable contracts.
 *
 * The scanner is chain-agnostic: pass any RPC URL + contract address.
 */

import { createPublicClient, http, type Address, parseAbi } from 'viem';
import type { Hex, Registration } from './types.js';
import type { Logger } from './types.js';

const ERC721_ENUMERABLE_ABI = parseAbi([
  'function totalSupply() view returns (uint256)',
  'function tokenByIndex(uint256 index) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
]);

const ERC721_TRANSFER_EVENT = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
]);

export interface BulkScanOptions {
  rpcUrl: string;
  contractAddress: Address;
  tronRecipient: Hex;
  payoutWallet: Hex;
  log: Logger;
  batchSize?: number;
}

export async function scanEntireCollection(opts: BulkScanOptions): Promise<Registration[]> {
  const { rpcUrl, contractAddress, tronRecipient, payoutWallet, log, batchSize = 100 } = opts;
  const client = createPublicClient({ transport: http(rpcUrl) });

  // Try ERC-721 Enumerable first
  try {
    const totalSupply = await client.readContract({
      address: contractAddress,
      abi: ERC721_ENUMERABLE_ABI,
      functionName: 'totalSupply',
    });

    log.info(`[bulk-scanner] ${contractAddress}: totalSupply=${totalSupply}, scanning via Enumerable`);

    const registrations: Registration[] = [];
    const total = Number(totalSupply);

    for (let i = 0; i < total; i += batchSize) {
      const end = Math.min(i + batchSize, total);
      const batch = await Promise.all(
        Array.from({ length: end - i }, (_, idx) =>
          client.readContract({
            address: contractAddress,
            abi: ERC721_ENUMERABLE_ABI,
            functionName: 'tokenByIndex',
            args: [BigInt(i + idx)],
          }),
        ),
      );

      for (const tokenId of batch) {
        registrations.push({ resTokenId: tokenId, tronRecipient, payoutWallet });
      }

      if (end < total) {
        log.info(`[bulk-scanner] progress: ${end}/${total}`);
      }
    }

    log.info(`[bulk-scanner] done: ${registrations.length} token(s) scanned`);
    return registrations;
  } catch {
    log.info('[bulk-scanner] Enumerable not supported, falling back to Transfer event scan');
  }

  // Fallback: scan Transfer events from zero address (mints)
  const latestBlock = await client.getBlockNumber();
  const registrations: Registration[] = [];
  const seen = new Set<string>();
  const chunkSize = BigInt(10_000);

  for (let from = 0n; from <= latestBlock; from += chunkSize) {
    const to = from + chunkSize - 1n > latestBlock ? latestBlock : from + chunkSize - 1n;
    const logs = await client.getLogs({
      address: contractAddress,
      event: ERC721_TRANSFER_EVENT[0],
      args: { from: '0x0000000000000000000000000000000000000000' as Address },
      fromBlock: from,
      toBlock: to,
    });

    for (const mintLog of logs) {
      const tokenId = mintLog.args.tokenId;
      if (tokenId === undefined) continue;
      const key = tokenId.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      registrations.push({ resTokenId: tokenId, tronRecipient, payoutWallet });
    }
  }

  log.info(`[bulk-scanner] done (event scan): ${registrations.length} token(s) found`);
  return registrations;
}
