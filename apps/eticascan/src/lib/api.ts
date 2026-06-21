const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://104.248.193.164";

export async function fetchAPI(path: string, params?: Record<string, string>) {
  const url = new URL(`${API_BASE}${path}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }
  const res = await fetch(url.toString(), { next: { revalidate: 12 } });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export async function getBlocks(page = 1) {
  return fetchAPI("/api/etica/blocks", { page: String(page) });
}

export async function getTransactions(page = 1) {
  return fetchAPI("/api/etica/transactions", { page: String(page) });
}

export async function getProposals(page = 1) {
  return fetchAPI("/api/etica/proposals", { page: String(page) });
}

export async function getDiseases(page = 1) {
  return fetchAPI("/api/etica/diseases", { page: String(page) });
}

export async function getTransfers(page = 1) {
  return fetchAPI("/api/etica/transfers", { page: String(page) });
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
