/**
 * USDC the keeper has sent through the bridge that the relayer has not
 * delivered yet. GitHub Actions is stateless, so a re-dispatch after a mint
 * timeout has to find the previous run's transfer on-chain instead of
 * bridging again: every `SentTransferRemote` to the keeper emitted by the
 * Ethereum router within the lookback is matched by amount against the
 * `ReceivedTransferRemote` events the Etica router emitted for the keeper;
 * whatever is left unmatched is still in flight.
 */

import { pad, parseAbiItem, type Address, type PublicClient } from 'viem';
import { LOG_CHUNK_BLOCKS, fetchInboundTransfers } from '../bridge-gas/gas-drop.js';
import { ETICA_DOMAIN, type BridgeSeedConfig } from './config.js';
import { unmatchedAmounts } from './plan.js';

const SENT_TRANSFER_REMOTE = parseAbiItem(
  'event SentTransferRemote(uint32 indexed destination, bytes32 indexed recipient, uint256 amount)',
);

export interface InflightScan {
  sent: bigint[];
  received: bigint[];
  pending: bigint[];
  ethereumBlocks: { from: bigint; to: bigint };
  eticaBlocks: { from: bigint; to: bigint };
}

/** Amounts the Ethereum router sent to `keeper` on Etica within the lookback, oldest first. */
export async function fetchOutboundToKeeper(
  client: PublicClient,
  router: Address,
  keeper: Address,
  lookbackBlocks: bigint,
  chunk: bigint = LOG_CHUNK_BLOCKS,
): Promise<{ amounts: bigint[]; fromBlock: bigint; toBlock: bigint }> {
  if (chunk <= 0n) throw new Error('log chunk must be positive');
  const toBlock = await client.getBlockNumber();
  const fromBlock = toBlock > lookbackBlocks ? toBlock - lookbackBlocks : 0n;
  // topic filters are byte-exact: a checksummed address must be lower-cased before padding
  const recipient = pad(keeper.toLowerCase() as Address, { size: 32 });
  const amounts: bigint[] = [];
  for (let start = fromBlock; start <= toBlock; start += chunk) {
    const end = start + chunk - 1n < toBlock ? start + chunk - 1n : toBlock;
    const logs = await client.getLogs({
      address: router,
      event: SENT_TRANSFER_REMOTE,
      args: { destination: ETICA_DOMAIN, recipient },
      fromBlock: start,
      toBlock: end,
    });
    for (const log of logs) {
      if (log.args.amount !== undefined) amounts.push(log.args.amount);
    }
  }
  return { amounts, fromBlock, toBlock };
}

export async function scanInflight(
  eth: PublicClient,
  eti: PublicClient,
  config: BridgeSeedConfig,
  keeper: Address,
): Promise<InflightScan> {
  const lookback = BigInt(config.inflightLookbackBlocks);
  const [out, inbound] = await Promise.all([
    fetchOutboundToKeeper(eth, config.ethereum.warpRouter, keeper, lookback),
    fetchInboundTransfers(eti, config.etica.usdce, lookback),
  ]);
  const received = inbound.transfers
    .filter((t) => t.recipient.toLowerCase() === keeper.toLowerCase())
    .map((t) => t.amount);
  return {
    sent: out.amounts,
    received,
    pending: unmatchedAmounts(out.amounts, received),
    ethereumBlocks: { from: out.fromBlock, to: out.toBlock },
    eticaBlocks: { from: inbound.fromBlock, to: inbound.toBlock },
  };
}
