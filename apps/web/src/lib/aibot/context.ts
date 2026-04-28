/**
 * Live-context retrieval for the Etica AI Telegram bot.
 *
 * The bot is grounded in real on-chain data via our public `/api/v1/*`
 * endpoints. Rather than embed a stale knowledge dump in the system
 * prompt, we fetch the same JSON that `/status` reads — TVL, 24h volume,
 * lifetime revenue, pool list, harvester runs — and inject it as a
 * `Live Context` block in the chat-completion request. The model is
 * instructed to source numeric claims from this block only.
 *
 * Network failures degrade gracefully: any individual endpoint that
 * times out or returns non-2xx is omitted from the context block. The
 * bot still answers, just without that one slice.
 */

const DEFAULT_FETCH_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_POOLS = 8;

export interface LiveContext {
  /** Fully rendered, prompt-ready context block (markdown-ish plain text). */
  text: string;
  /** Endpoints that failed to load, kept for observability/logging. */
  errors: Array<{ endpoint: string; error: string }>;
  /** Endpoints that succeeded. */
  loaded: string[];
}

interface TvlPayload {
  etx_tvl?: number;
  usd_tvl?: number | null;
  pool_count?: number;
}

interface StatsPayload {
  pair_count?: number;
  block_number?: number;
  listed_assets?: string[];
}

interface PoolsPayload {
  pools?: Array<{
    base?: { symbol?: string; address?: string };
    quote?: { symbol?: string; address?: string };
    price?: number | string;
    volume_24h?: { base?: number; quote?: number; swap_count?: number };
  }>;
}

interface RevenuePayload {
  volume_etx?: number;
  volume_usd?: number | null;
  lp_fees_etx?: number;
  protocol_fees_accrued_etx?: number;
  protocol_fees_realized_etx?: number;
  harvest?: {
    runs?: number;
    last_run_unix?: number | null;
    total_etx_burned_pol?: number;
    total_etx_to_treasury?: number;
    total_etx_to_stetx?: number;
    total_etx_to_farms?: number;
  };
}

interface LiquidityFlowPayload {
  lp_retention_pct?: number | null;
  total_lp_minted_etx?: number;
  total_lp_burned_etx?: number;
}

interface TokenSnapshotPayload {
  token?: { id?: string; symbol?: string; decimals?: number };
  supply?: {
    totalSupplyFormatted?: string;
    circulatingSupplyFormatted?: string;
    burnedFormatted?: string;
  } | null;
  prices?: Record<string, number | null>;
}

async function fetchJson<T>(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ data: T | null; error: string | null }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: ac.signal,
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      return { data: null, error: `http ${res.status}` };
    }
    const data = (await res.json()) as T;
    return { data, error: null };
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function fmtUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(2)}K`;
  return `$${v.toFixed(2)}`;
}

function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(2)}K`;
  return v.toFixed(digits);
}

function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${v.toFixed(2)}%`;
}

function fmtAgo(unix: number | null | undefined, nowUnix: number): string {
  if (unix === null || unix === undefined || !Number.isFinite(unix)) return '—';
  const seconds = Math.max(0, nowUnix - unix);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export interface FetchLiveContextOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Cap on how many pools to render in the context block. */
  maxPools?: number;
  /** Used by tests to render deterministic "ago" timestamps. */
  nowUnix?: number;
}

/**
 * Fetch the live `/api/v1/*` slices and render them as a single text
 * block ready to inject into the system prompt.
 */
export async function fetchLiveContext(opts: FetchLiveContextOptions): Promise<LiveContext> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const maxPools = opts.maxPools ?? DEFAULT_MAX_POOLS;
  const nowUnix = opts.nowUnix ?? Math.floor(Date.now() / 1000);
  const base = opts.baseUrl.replace(/\/$/, '');

  const [tvl, stats, pools, revenue, flow, etxToken, stetxToken] = await Promise.all([
    fetchJson<TvlPayload>(`${base}/api/v1/tvl`, fetchImpl, timeoutMs),
    fetchJson<StatsPayload>(`${base}/api/v1/stats`, fetchImpl, timeoutMs),
    fetchJson<PoolsPayload>(`${base}/api/v1/pools`, fetchImpl, timeoutMs),
    fetchJson<RevenuePayload>(`${base}/api/v1/revenue`, fetchImpl, timeoutMs),
    fetchJson<LiquidityFlowPayload>(`${base}/api/v1/liquidity-flow`, fetchImpl, timeoutMs),
    fetchJson<TokenSnapshotPayload>(`${base}/api/v1/tokens/etx`, fetchImpl, timeoutMs),
    fetchJson<TokenSnapshotPayload>(`${base}/api/v1/tokens/stetx`, fetchImpl, timeoutMs),
  ]);

  const errors: LiveContext['errors'] = [];
  const loaded: string[] = [];
  const lines: string[] = [];

  if (tvl.data) {
    loaded.push('tvl');
    lines.push(
      `TVL: ${fmtUsd(tvl.data.usd_tvl)} (${fmtNum(tvl.data.etx_tvl, 0)} ETX) across ${tvl.data.pool_count ?? '—'} pools`,
    );
  } else {
    errors.push({ endpoint: '/api/v1/tvl', error: tvl.error ?? 'unknown' });
  }

  if (stats.data) {
    loaded.push('stats');
    if (typeof stats.data.block_number === 'number') {
      lines.push(`Head block: ${stats.data.block_number}`);
    }
    const assets = stats.data.listed_assets ?? [];
    if (assets.length > 0) {
      lines.push(`Listed assets with liquidity: ${assets.join(', ')}`);
    }
  } else {
    errors.push({ endpoint: '/api/v1/stats', error: stats.error ?? 'unknown' });
  }

  if (revenue.data) {
    loaded.push('revenue');
    lines.push(
      `Lifetime swap volume: ${fmtUsd(revenue.data.volume_usd)} (${fmtNum(revenue.data.volume_etx, 0)} ETX)`,
    );
    if (typeof revenue.data.lp_fees_etx === 'number') {
      lines.push(`LP fees paid: ${fmtNum(revenue.data.lp_fees_etx, 0)} ETX (0.30% of volume)`);
    }
    if (typeof revenue.data.protocol_fees_realized_etx === 'number') {
      lines.push(
        `Protocol fees realized: ${fmtNum(revenue.data.protocol_fees_realized_etx, 0)} ETX (already in treasury)`,
      );
    }
    if (typeof revenue.data.protocol_fees_accrued_etx === 'number') {
      lines.push(
        `Protocol fees accrued (unredeemed): ${fmtNum(revenue.data.protocol_fees_accrued_etx, 0)} ETX`,
      );
    }
    const h = revenue.data.harvest;
    if (h && typeof h.runs === 'number') {
      lines.push(
        `TreasuryHarvester: ${h.runs} runs · last run ${fmtAgo(h.last_run_unix ?? null, nowUnix)} · ` +
          `${fmtNum(h.total_etx_burned_pol ?? 0, 0)} ETX burned to POL · ` +
          `${fmtNum(h.total_etx_to_stetx ?? 0, 0)} ETX → stETX · ` +
          `${fmtNum(h.total_etx_to_farms ?? 0, 0)} ETX → farms · ` +
          `${fmtNum(h.total_etx_to_treasury ?? 0, 0)} ETX → treasury`,
      );
    }
  } else {
    errors.push({ endpoint: '/api/v1/revenue', error: revenue.error ?? 'unknown' });
  }

  if (flow.data) {
    loaded.push('liquidity-flow');
    lines.push(
      `LP retention since launch: ${fmtPct(flow.data.lp_retention_pct ?? null)} ` +
        `(minted ${fmtNum(flow.data.total_lp_minted_etx ?? 0, 0)} ETX, burned ${fmtNum(flow.data.total_lp_burned_etx ?? 0, 0)} ETX)`,
    );
  } else {
    errors.push({ endpoint: '/api/v1/liquidity-flow', error: flow.error ?? 'unknown' });
  }

  if (etxToken.data?.supply) {
    loaded.push('tokens/etx');
    const s = etxToken.data.supply;
    const total = s.totalSupplyFormatted;
    const circ = s.circulatingSupplyFormatted;
    const burned = s.burnedFormatted;
    const parts: string[] = [];
    if (total) parts.push(`total ${total}`);
    if (circ) parts.push(`circulating ${circ}`);
    if (burned && burned !== '0') parts.push(`burned ${burned}`);
    if (parts.length > 0) lines.push(`ETX supply: ${parts.join(' · ')}`);
  } else {
    errors.push({ endpoint: '/api/v1/tokens/etx', error: etxToken.error ?? 'unknown' });
  }

  if (stetxToken.data) {
    loaded.push('tokens/stetx');
    const s = stetxToken.data.supply;
    const totalsParts: string[] = [];
    if (s?.totalSupplyFormatted) totalsParts.push(`total ${s.totalSupplyFormatted}`);
    if (s?.circulatingSupplyFormatted) totalsParts.push(`circulating ${s.circulatingSupplyFormatted}`);
    if (totalsParts.length > 0) lines.push(`stETX supply: ${totalsParts.join(' · ')}`);
    const stetxToEtx = stetxToken.data.prices?.etx;
    if (typeof stetxToEtx === 'number' && Number.isFinite(stetxToEtx)) {
      lines.push(`stETX exchange rate: 1 stETX = ${stetxToEtx.toFixed(6)} ETX`);
    }
  } else {
    errors.push({ endpoint: '/api/v1/tokens/stetx', error: stetxToken.error ?? 'unknown' });
  }

  if (pools.data?.pools) {
    loaded.push('pools');
    const top = pools.data.pools.slice(0, maxPools);
    const poolLines = top
      .map((p) => {
        const baseSym = p.base?.symbol ?? '?';
        const quoteSym = p.quote?.symbol ?? '?';
        const price = typeof p.price === 'number' ? p.price : Number(p.price);
        const swaps = p.volume_24h?.swap_count;
        const tag = Number.isFinite(price)
          ? `1 ${baseSym} = ${price.toFixed(price < 1 ? 6 : 4)} ${quoteSym}`
          : `${baseSym}/${quoteSym}`;
        const swapTag = typeof swaps === 'number' && swaps > 0 ? ` · ${swaps} swaps/24h` : '';
        return `  - ${baseSym}/${quoteSym}: ${tag}${swapTag}`;
      })
      .join('\n');
    if (poolLines.length > 0) {
      lines.push(`Active pools (top ${top.length}):\n${poolLines}`);
    }
  } else {
    errors.push({ endpoint: '/api/v1/pools', error: pools.error ?? 'unknown' });
  }

  const text =
    lines.length > 0
      ? lines.join('\n')
      : '(live context unavailable — every /api/v1 endpoint failed; answer carefully and avoid quoting numbers)';

  return { text, errors, loaded };
}
