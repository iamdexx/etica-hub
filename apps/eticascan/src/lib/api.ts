const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://104.248.193.164";

/**
 * Upstream indexer rows are loosely typed and mix camelCase / lowercase
 * variants of the same field, so every field is optional and pages fall
 * back between spellings.
 */
export interface Block {
  number?: number | string;
  hash?: string;
  parenthash?: string;
  miner?: string;
  timestamp?: number | string;
  nbtxs?: number | string;
  gasUsed?: number | string;
  gasused?: number | string;
  gasLimit?: number | string;
  gaslimit?: number | string;
  difficulty?: number | string;
  totalDifficulty?: number | string;
  totaldifficulty?: number | string;
  size?: number | string;
  nonce?: string;
  extraData?: string;
  extradata?: string;
}

export interface Transaction {
  hash?: string;
  blockNumber?: number | string;
  blocknumber?: number | string;
  from_address?: string;
  fromaddress?: string;
  to_address?: string;
  toaddress?: string;
  value?: number | string;
  gasPrice?: number | string;
  gasprice?: number | string;
  gasUsed?: number | string;
  gasused?: number | string;
  nonce?: number | string;
  status?: number | string | boolean;
  input?: string;
  inputdata?: string;
  timestamp?: number | string;
  created_at?: string;
}

export interface Transfer {
  hash?: string;
  transactionhash?: string;
  fromaddress?: string;
  toaddress?: string;
  value?: number | string;
  created_at?: string;
}

export interface Proposal {
  id?: number | string;
  hash?: string;
  proposalhash?: string;
  proposer?: string;
  diseasehash?: string;
  chunkid?: number | string;
  raw_release_hash?: string;
  created_at?: string;
}

export interface Disease {
  id?: number | string;
  name?: string;
  title?: string;
  diseasehash?: string;
}

export interface Paginated<T> {
  data: T[];
}

export interface PaginationLinks {
  next?: string | null;
  prev?: string | null;
}

export interface BlocksResponse {
  blocks: Paginated<Block>;
  links?: PaginationLinks;
}
export interface TransactionsResponse {
  transactions: Paginated<Transaction>;
  links?: PaginationLinks;
}
export interface TransfersResponse {
  transfers: Paginated<Transfer>;
  links?: PaginationLinks;
}
export interface ProposalsResponse {
  proposals: Paginated<Proposal>;
  links?: PaginationLinks;
}
export interface DiseasesResponse {
  diseases: Paginated<Disease>;
  links?: PaginationLinks;
}

export async function fetchAPI<T = unknown>(
  path: string,
  params?: Record<string, string>,
): Promise<T> {
  const url = new URL(`${API_BASE}${path}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }
  const res = await fetch(url.toString(), { next: { revalidate: 12 } });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json() as Promise<T>;
}

export async function getBlocks(page = 1) {
  return fetchAPI<BlocksResponse>("/api/etica/blocks", { page: String(page) });
}

export async function getTransactions(page = 1) {
  return fetchAPI<TransactionsResponse>("/api/etica/transactions", { page: String(page) });
}

export async function getProposals(page = 1) {
  return fetchAPI<ProposalsResponse>("/api/etica/proposals", { page: String(page) });
}

export async function getDiseases(page = 1) {
  return fetchAPI<DiseasesResponse>("/api/etica/diseases", { page: String(page) });
}

export async function getTransfers(page = 1) {
  return fetchAPI<TransfersResponse>("/api/etica/transfers", { page: String(page) });
}

export async function getStakes(page = 1) {
  return fetchAPI("/api/etica/newstakes", { page: String(page) });
}

export async function getCommits(page = 1) {
  return fetchAPI("/api/etica/newcommits", { page: String(page) });
}

export async function getReveals(page = 1) {
  return fetchAPI("/api/etica/newreveals", { page: String(page) });
}

export async function getRewardClaims(page = 1) {
  return fetchAPI("/api/etica/rewardclaims", { page: String(page) });
}

export async function getPeriods(page = 1) {
  return fetchAPI("/api/etica/periods", { page: String(page) });
}
