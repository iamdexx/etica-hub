import type { Chain, PublicClient, Hex } from 'viem';
import { abis, EXTERNAL_ADDRESSES, type SupportedChainId } from '@etica-hub/shared';

const { eticaCoreAbi, PROPOSAL_STATUS_LABEL } = abis;

/**
 * Research Hub indexer module.
 *
 * Responsibilities (Phase 2):
 *   1. On boot, print the chain's proposal counter + the last N proposals so
 *      operators can confirm connectivity to the configured RPC.
 *   2. Watch `NewProposal` / `NewDisease` / `NewReveal` events going forward
 *      and log them in a structured form. A durable store (Postgres / SQLite)
 *      will be wired in a follow-up PR; the log format is already JSONL so
 *      it can be piped straight into one.
 *
 * This keeps the Phase 2 scaffold runnable against the local anvil fork, the
 * Crucible testnet, or mainnet — without introducing a DB dependency yet.
 */
export interface ResearchIndexerOptions {
  client: PublicClient;
  chain: Chain;
  chainId: SupportedChainId;
  previewCount?: number;
}

export async function runResearchIndexer({
  client,
  chain,
  chainId,
  previewCount = 5,
}: ResearchIndexerOptions): Promise<void> {
  const core = EXTERNAL_ADDRESSES[chainId].eticaCore;

  const total = (await client.readContract({
    abi: eticaCoreAbi,
    address: core,
    functionName: 'proposalsCounter',
  })) as bigint;

  log('research.bootstrap', {
    chain: chain.name,
    chainId,
    eticaCore: core,
    proposalsTotal: total.toString(),
  });

  if (total > 0n) {
    const preview = Math.min(previewCount, Number(total));
    const ids = Array.from({ length: preview }, (_, i) => total - BigInt(i));

    for (const id of ids) {
      try {
        const hash = (await client.readContract({
          abi: eticaCoreAbi,
          address: core,
          functionName: 'proposalsbyIndex',
          args: [id],
        })) as Hex;

        const [proposal, data] = await Promise.all([
          client.readContract({
            abi: eticaCoreAbi,
            address: core,
            functionName: 'proposals',
            args: [hash],
          }),
          client.readContract({
            abi: eticaCoreAbi,
            address: core,
            functionName: 'propsdatas',
            args: [hash],
          }),
        ]);

        const [pid, , diseaseId, , chunkId, proposer, title] = proposal as readonly [
          bigint,
          Hex,
          Hex,
          bigint,
          bigint,
          `0x${string}`,
          string,
          string,
          string,
          string,
        ];
        const [starttime, endtime, , statusRaw] = data as readonly [
          bigint,
          bigint,
          bigint,
          number,
          number,
          boolean,
          bigint,
          bigint,
          bigint,
          bigint,
          bigint,
          bigint,
          bigint,
        ];

        log('research.proposal', {
          id: pid.toString(),
          hash,
          title,
          proposer,
          diseaseId,
          chunkId: chunkId.toString(),
          status:
            PROPOSAL_STATUS_LABEL[statusRaw as keyof typeof PROPOSAL_STATUS_LABEL] ??
            `unknown(${statusRaw})`,
          starttime: starttime.toString(),
          endtime: endtime.toString(),
        });
      } catch (err) {
        log('research.proposal_error', {
          id: id.toString(),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Watch new events going forward. No DB yet — structured logs only.
  client.watchContractEvent({
    abi: eticaCoreAbi,
    address: core,
    eventName: 'NewProposal',
    onLogs: (logs) => {
      for (const l of logs) {
        log('research.event.new_proposal', {
          block: l.blockNumber?.toString(),
          tx: l.transactionHash,
          hash: l.args.proposed_release_hash,
          proposer: l.args._proposer,
          diseaseHash: l.args.diseasehash,
          chunkId: l.args.chunkid?.toString(),
        });
      }
    },
    onError: (err) => log('research.watch_error', { event: 'NewProposal', error: err.message }),
  });

  client.watchContractEvent({
    abi: eticaCoreAbi,
    address: core,
    eventName: 'NewDisease',
    onLogs: (logs) => {
      for (const l of logs) {
        log('research.event.new_disease', {
          block: l.blockNumber?.toString(),
          tx: l.transactionHash,
          diseaseIndex: l.args.diseaseindex?.toString(),
          title: l.args.title,
        });
      }
    },
    onError: (err) => log('research.watch_error', { event: 'NewDisease', error: err.message }),
  });

  client.watchContractEvent({
    abi: eticaCoreAbi,
    address: core,
    eventName: 'NewReveal',
    onLogs: (logs) => {
      for (const l of logs) {
        log('research.event.new_reveal', {
          block: l.blockNumber?.toString(),
          tx: l.transactionHash,
          voter: l.args._voter,
          proposal: l.args._proposal,
          amount: l.args.amount?.toString(),
        });
      }
    },
    onError: (err) => log('research.watch_error', { event: 'NewReveal', error: err.message }),
  });

  log('research.watching', { events: ['NewProposal', 'NewDisease', 'NewReveal'] });
}

function log(event: string, payload: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...payload }));
}
