/**
 * Single catalogue of public read-only endpoints. Drives the /api docs page
 * and the machine-readable /api/openapi.json spec so the two can't drift.
 */

export interface EndpointRow {
  method: 'GET';
  pathTemplate: string;
  example: string;
  summary: string;
  /** Response media type when not JSON. */
  contentType?: string;
}

export const ENDPOINTS: EndpointRow[] = [
  {
    method: 'GET',
    pathTemplate: '/api/v1/tokens',
    example: '/api/v1/tokens',
    summary: 'List every token the API reports on (id, symbol, decimals, address).',
  },
  {
    method: 'GET',
    pathTemplate: '/api/v1/tokens/[id]',
    example: '/api/v1/tokens/etx',
    summary: 'Per-token live snapshot — supply stats + spot prices vs every other tracked token.',
  },
  {
    method: 'GET',
    pathTemplate: '/api/v1/supply/total?token=etx',
    example: '/api/v1/supply/total?token=etx',
    contentType: 'text/plain',
    summary:
      'Plain-text total supply, ERC-20 decimals-formatted. Paste directly into CoinGecko/CMC forms.',
  },
  {
    method: 'GET',
    pathTemplate: '/api/v1/supply/circulating?token=etx',
    example: '/api/v1/supply/circulating?token=etx',
    contentType: 'text/plain',
    summary: 'Plain-text circulating supply (total minus balance at 0x…dEaD).',
  },
  {
    method: 'GET',
    pathTemplate: '/api/v1/supply/burned?token=etx',
    example: '/api/v1/supply/burned?token=etx',
    contentType: 'text/plain',
    summary: 'Plain-text balance at the canonical POL-burn address.',
  },
  {
    method: 'GET',
    pathTemplate: '/api/v1/pairs',
    example: '/api/v1/pairs',
    summary: 'Every EticaSwap V2 pair with live reserves and ETX-denominated spot.',
  },
  {
    method: 'GET',
    pathTemplate: '/api/v1/pairs/[address]',
    example: '/api/v1/pairs/0x7009DED3686b61fa3ae2c5E5cEe56042BefEBE68',
    summary: 'Detail view for a single pair address. Both price directions.',
  },
  {
    method: 'GET',
    pathTemplate: '/api/v1/simple/price?ids=…&vs_currencies=…',
    example: '/api/v1/simple/price?ids=etx,eti,egaz&vs_currencies=etx,egaz',
    summary: 'CoinGecko-compatible price lookup with one-hop routing via ETX.',
  },
  {
    method: 'GET',
    pathTemplate: '/api/v1/ohlcv/[pair]?interval=1h&limit=100',
    example: '/api/v1/ohlcv/ETI-ETX?interval=1h&limit=100',
    summary: 'Short-range OHLC candles derived from pair Sync events.',
  },
  {
    method: 'GET',
    pathTemplate: '/api/v1/pools',
    example: '/api/v1/pools',
    summary: 'GeckoTerminal-style pools schema with native token0/token1 orientation.',
  },
  {
    method: 'GET',
    pathTemplate: '/api/v1/tvl',
    example: '/api/v1/tvl',
    summary: 'Total value locked across every ETX-hub pool (ETX + USD, per-pool breakdown).',
  },
  {
    method: 'GET',
    pathTemplate: '/api/v1/revenue',
    example: '/api/v1/revenue',
    summary:
      'Lifetime protocol revenue since DEX launch — volume, LP fees, accrued + realized protocol fees.',
  },
  {
    method: 'GET',
    pathTemplate: '/api/v1/liquidity-flow',
    example: '/api/v1/liquidity-flow',
    summary:
      'Lifetime Mint + Burn activity per pool with net flow (negative on net outflow) and POL locked at 0xdead.',
  },
  {
    method: 'GET',
    pathTemplate: '/api/v1/stats',
    example: '/api/v1/stats',
    summary: 'Status-page snapshot: head block, pair count, tracked tokens.',
  },
  {
    method: 'GET',
    pathTemplate: '/api/v1/health',
    example: '/api/v1/health',
    summary: 'Liveness check for aggregator bots (200 healthy / 503 stale).',
  },
];

export const LABS_ENDPOINTS: EndpointRow[] = [
  {
    method: 'GET',
    pathTemplate: '/api/labs/archive?q=…&disease=…&limit=50',
    example: '/api/labs/archive?limit=5',
    summary:
      'Search the permanent Labs research archive — full-text, disease, target, source, score filters; returns candidates + scores.',
  },
  {
    method: 'GET',
    pathTemplate: '/api/labs/archive/[id]',
    example: '/api/labs/archive/latest',
    summary:
      'One archived research record with every candidate, rationale, fold engine and Cα PDB reference.',
  },
  {
    method: 'GET',
    pathTemplate: '/api/labs/archive/stats',
    example: '/api/labs/archive/stats',
    summary:
      'Lifetime Labs counters: research runs, proteins designed, folds, diseases, minted RES NFTs.',
  },
  {
    method: 'GET',
    pathTemplate: '/labs/feed.xml',
    example: '/labs/feed.xml',
    summary: 'Atom feed of the 50 newest discoveries (title, disease, score, structure image).',
    contentType: 'application/atom+xml',
  },
  {
    method: 'GET',
    pathTemplate: '/labs/feed.json',
    example: '/labs/feed.json',
    summary: 'JSON Feed 1.1 of the same discoveries with structured score/engine metadata.',
    contentType: 'application/feed+json',
  },
];
