import 'server-only';
import { createPublicClient, http, type Address, type Hex, type PublicClient } from 'viem';
import {
  abis,
  EXTERNAL_ADDRESSES,
  eticaCrucible,
  eticaLocalFork,
  eticaMainnet,
  isSupportedChainId,
  PROPOSAL_STATUS_LABEL,
  ProposalStatus,
  type SupportedChainId,
} from '@etica-hub/shared';

/**
 * Server-side helpers for reading research data off the Etica core contract.
 *
 * Results are cached in the default Next fetch cache via ISR (`revalidate`);
 * no dedicated DB for Phase 2. Latency is bounded by a single multicall per
 * list page + one per detail page.
 */

const { eticaCoreAbi } = abis;

export type ProposalSummary = {
  id: bigint;
  hash: Hex;
  title: string;
  proposer: Address;
  diseaseId: Hex;
  diseaseName: string | undefined;
  chunkId: bigint;
  status: ProposalStatus;
  statusLabel: string;
  starttime: bigint;
  endtime: bigint;
  finalizedTime: bigint;
  forvotes: bigint;
  againstvotes: bigint;
  nbvoters: bigint;
};

export type ProposalDetail = ProposalSummary & {
  description: string;
  freefield: string;
  rawReleaseHash: string;
  ipfs:
    | { kind: 'ipfs'; cid: string; gatewayUrl: string }
    | { kind: 'raw'; value: string }
    | { kind: 'empty' };
  approvalThreshold: bigint;
  istie: boolean;
  slashingratio: bigint;
};

export type Disease = {
  index: bigint;
  hash: Hex;
  name: string;
};

export const DEFAULT_IPFS_GATEWAY = 'https://cloudflare-ipfs.com/ipfs/';
const IPFS_CID_REGEX = /^(Qm[1-9A-HJ-NP-Za-km-z]{44,}|b[A-Za-z2-7]{58,})$/;

export function resolveChainId(): SupportedChainId {
  const raw = process.env.NEXT_PUBLIC_RESEARCH_CHAIN_ID ?? process.env.CHAIN_ID;
  const id = raw ? Number(raw) : eticaMainnet.id;
  return isSupportedChainId(id) ? id : eticaMainnet.id;
}

export function getResearchClient(chainId: SupportedChainId = resolveChainId()): PublicClient {
  const chain =
    chainId === eticaMainnet.id
      ? eticaMainnet
      : chainId === eticaCrucible.id
        ? eticaCrucible
        : eticaLocalFork;

  const rpcUrl =
    chainId === eticaMainnet.id
      ? process.env.ETICA_MAINNET_RPC_URL
      : chainId === eticaCrucible.id
        ? process.env.ETICA_CRUCIBLE_RPC_URL
        : (process.env.ETICA_LOCAL_RPC_URL ?? 'http://127.0.0.1:8545');

  return createPublicClient({
    chain,
    transport: rpcUrl ? http(rpcUrl) : http(),
  }) as PublicClient;
}

/**
 * `raw_release_hash` in Etica proposals is conventionally an IPFS CID, but
 * older proposals put arbitrary strings there. Classify so the UI can decide
 * whether to render a live IPFS fetch vs. plain text.
 */
export function classifyRawReleaseHash(raw: string): ProposalDetail['ipfs'] {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: 'empty' };
  if (IPFS_CID_REGEX.test(trimmed)) {
    return {
      kind: 'ipfs',
      cid: trimmed,
      gatewayUrl: `${DEFAULT_IPFS_GATEWAY}${trimmed}`,
    };
  }
  return { kind: 'raw', value: trimmed };
}

function normalizeStatus(raw: number): ProposalStatus {
  switch (raw) {
    case 0:
      return ProposalStatus.Rejected;
    case 1:
      return ProposalStatus.Accepted;
    case 2:
      return ProposalStatus.Pending;
    case 3:
      return ProposalStatus.Singlevoter;
    default:
      return ProposalStatus.Pending;
  }
}

/** Read the total proposal count on the configured chain. */
export async function getProposalsCount(
  chainId: SupportedChainId = resolveChainId(),
): Promise<bigint> {
  const client = getResearchClient(chainId);
  const core = EXTERNAL_ADDRESSES[chainId].eticaCore;
  return client.readContract({
    abi: eticaCoreAbi,
    address: core,
    functionName: 'proposalsCounter',
  }) as Promise<bigint>;
}

async function getDiseaseName(
  client: PublicClient,
  core: Address,
  diseaseHash: Hex,
): Promise<string | undefined> {
  try {
    const idx = (await client.readContract({
      abi: eticaCoreAbi,
      address: core,
      functionName: 'diseasesbyIds',
      args: [diseaseHash],
    })) as bigint;
    const [, name] = (await client.readContract({
      abi: eticaCoreAbi,
      address: core,
      functionName: 'diseases',
      args: [idx],
    })) as [Hex, string];
    return name;
  } catch {
    return undefined;
  }
}

/**
 * Return the last `limit` proposals on the configured chain, newest first.
 * Truncates to `[0, proposalsCounter)` on empty chains.
 */
export async function listRecentProposals(
  limit = 20,
  chainId: SupportedChainId = resolveChainId(),
): Promise<ProposalSummary[]> {
  const client = getResearchClient(chainId);
  const core = EXTERNAL_ADDRESSES[chainId].eticaCore;
  const total = await getProposalsCount(chainId);
  if (total === 0n) return [];

  const count = total < BigInt(limit) ? Number(total) : limit;

  // Etica indexes proposals 1..proposalsCounter (first real id is 1).
  const indexes = Array.from({ length: count }, (_, i) => total - BigInt(i)).filter((i) => i >= 1n);

  const hashes = (await Promise.all(
    indexes.map((i) =>
      client.readContract({
        abi: eticaCoreAbi,
        address: core,
        functionName: 'proposalsbyIndex',
        args: [i],
      }),
    ),
  )) as Hex[];

  const raw = await Promise.all(
    hashes.map(async (hash) => {
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
      return { hash, proposal, data };
    }),
  );

  const uniqueDiseases = new Map<Hex, Promise<string | undefined>>();
  const resolveDisease = (id: Hex) => {
    if (!uniqueDiseases.has(id)) {
      uniqueDiseases.set(id, getDiseaseName(client, core, id));
    }
    return uniqueDiseases.get(id)!;
  };

  return Promise.all(
    raw.map(async ({ hash, proposal, data }) => {
      const [id, , diseaseId, , chunkId, proposer, title] = proposal as readonly [
        bigint,
        Hex,
        Hex,
        bigint,
        bigint,
        Address,
        string,
        string,
        string,
        string,
      ];
      const [starttime, endtime, finalizedTime, statusRaw, , , nbvoters, , forvotes, againstvotes] =
        data as readonly [
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

      const status = normalizeStatus(statusRaw);
      const diseaseName = await resolveDisease(diseaseId);

      return {
        id,
        hash,
        title,
        proposer,
        diseaseId,
        diseaseName,
        chunkId,
        status,
        statusLabel: PROPOSAL_STATUS_LABEL[status],
        starttime,
        endtime,
        finalizedTime,
        forvotes,
        againstvotes,
        nbvoters,
      } satisfies ProposalSummary;
    }),
  );
}

/** Fetch a single proposal's on-chain data (both `proposals` + `propsdatas`). */
export async function getProposal(
  hash: Hex,
  chainId: SupportedChainId = resolveChainId(),
): Promise<ProposalDetail | undefined> {
  const client = getResearchClient(chainId);
  const core = EXTERNAL_ADDRESSES[chainId].eticaCore;

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

  const [id, , diseaseId, , chunkId, proposer, title, description, freefield, rawReleaseHash] =
    proposal as readonly [
      bigint,
      Hex,
      Hex,
      bigint,
      bigint,
      Address,
      string,
      string,
      string,
      string,
    ];

  if (id === 0n) return undefined;

  const [
    starttime,
    endtime,
    finalizedTime,
    statusRaw,
    ,
    istie,
    nbvoters,
    slashingratio,
    forvotes,
    againstvotes,
    ,
    ,
    approvalThreshold,
  ] = data as readonly [
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

  const status = normalizeStatus(statusRaw);
  const diseaseName = await getDiseaseName(client, core, diseaseId);

  return {
    id,
    hash,
    title,
    proposer,
    diseaseId,
    diseaseName,
    chunkId,
    status,
    statusLabel: PROPOSAL_STATUS_LABEL[status],
    starttime,
    endtime,
    finalizedTime,
    forvotes,
    againstvotes,
    nbvoters,
    description,
    freefield,
    rawReleaseHash,
    ipfs: classifyRawReleaseHash(rawReleaseHash),
    approvalThreshold,
    istie,
    slashingratio,
  } satisfies ProposalDetail;
}

/**
 * Best-effort IPFS fetch for a proposal's `raw_release_hash`. Returns
 * undefined on network error so the UI can fall back to the gateway link.
 */
export async function fetchIpfsText(cid: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${DEFAULT_IPFS_GATEWAY}${cid}`, {
      next: { revalidate: 600 },
    });
    if (!res.ok) return undefined;
    const text = await res.text();
    // hard cap on what we render — avoid dumping 10MB documents into HTML
    return text.slice(0, 200_000);
  } catch {
    return undefined;
  }
}

export function shortAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
