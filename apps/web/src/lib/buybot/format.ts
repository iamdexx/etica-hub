/**
 * Telegram message formatter for the buy bot.
 *
 * All posts share one layout:
 *
 *     🟢 {BOUGHT} Buy on EticaHub
 *
 *     💸 Swap   {amountSpent} {SPENT} → {amountBought} {BOUGHT}
 *     💵 Value  ${notionalUsd}
 *     📊 Price  1 {BOUGHT} = {price} {SPENT}  ($usd)
 *
 *     🧢 MC {BOUGHT}  $x.xxM
 *     🧢 MC {SPENT}   $x.xxM
 *
 *     🔗 <a href="{explorer}/tx/{hash}">view tx</a>
 *
 * Output uses Telegram's `HTML` parse mode (safer than Markdown around
 * token symbols that contain underscores / asterisks).
 */

import type { DecodedBuy } from './prices';

export interface FormattedBuy {
  text: string;
  parseMode: 'HTML';
  disableWebPreview: true;
}

export interface FormatInputs {
  decoded: DecodedBuy;
  report: {
    amountBought: number;
    amountSpent: number;
    pricePerBoughtInSpent: number;
    pricePerBoughtInUsd: number | null;
    notionalUsd: number | null;
    mcBoughtUsd: number | null;
    mcSpentUsd: number | null;
  };
  txHash: string;
  blockNumber: bigint;
  explorerBaseUrl: string;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function formatAmount(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(2)}k`;
  if (abs >= 1) return n.toFixed(4).replace(/\.?0+$/, '');
  if (abs >= 0.0001) return n.toFixed(6).replace(/\.?0+$/, '');
  return n.toExponential(2);
}

export function formatUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  if (n === 0) return '$0.00';
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(2)}k`;
  if (abs >= 1) return `$${n.toFixed(2)}`;
  if (abs >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toExponential(2)}`;
}

export function formatPriceUnit(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '—';
  const abs = Math.abs(n);
  if (abs >= 1) return n.toFixed(6).replace(/\.?0+$/, '');
  if (abs >= 0.0001) return n.toFixed(8).replace(/\.?0+$/, '');
  return n.toExponential(3);
}

/**
 * Pick an emoji for the bought token so different token pages in the channel
 * are visually distinguishable at a glance.
 */
function emojiForSymbol(symbol: string): string {
  switch (symbol.toUpperCase()) {
    case 'ETX':
      return '🟣';
    case 'ETI':
      return '🟢';
    case 'EGAZ':
    case 'WEGAZ':
      return '⛽';
    default:
      return '🪙';
  }
}

export function formatBuy({
  decoded,
  report,
  txHash,
  blockNumber,
  explorerBaseUrl,
}: FormatInputs): FormattedBuy {
  const sym = {
    bought: escapeHtml(decoded.bought.symbol),
    spent: escapeHtml(decoded.spent.symbol),
  };
  const emoji = emojiForSymbol(decoded.bought.symbol);
  const priceLineUsd =
    report.pricePerBoughtInUsd !== null ? ` (${formatUsd(report.pricePerBoughtInUsd)})` : '';

  const base = explorerBaseUrl.replace(/\/$/, '');
  const txUrl = `${base}/explorer/tx/${txHash}`;
  const blockUrl = `${base}/explorer/block/${blockNumber.toString()}`;

  // MC lines are omitted entirely when null. Suppression happens upstream
  // in `computeBuyReport` (e.g. `hideMcForTokens` for stETX, where price ×
  // share supply just reproduces the underlying ETX MC and would
  // double-count it). A `—` placeholder would invite confusion.
  const mcLines: string[] = [];
  if (report.mcBoughtUsd !== null) {
    mcLines.push(`🧢 <b>MC ${sym.bought}</b>  ${formatUsd(report.mcBoughtUsd)}`);
  }
  if (report.mcSpentUsd !== null) {
    mcLines.push(`🧢 <b>MC ${sym.spent}</b>   ${formatUsd(report.mcSpentUsd)}`);
  }

  const lines = [
    `${emoji} <b>${sym.bought} Buy</b> on EticaHub`,
    '',
    `💸 <b>Swap</b>   ${formatAmount(report.amountSpent)} ${sym.spent} → ${formatAmount(report.amountBought)} ${sym.bought}`,
    `💵 <b>Value</b>  ${formatUsd(report.notionalUsd)}`,
    `📊 <b>Price</b>  1 ${sym.bought} = ${formatPriceUnit(report.pricePerBoughtInSpent)} ${sym.spent}${priceLineUsd}`,
    ...(mcLines.length > 0 ? ['', ...mcLines] : []),
    '',
    `🔗 <a href="${escapeHtml(txUrl)}">view tx</a>  ·  <a href="${escapeHtml(blockUrl)}">block ${blockNumber.toString()}</a>`,
  ];

  return {
    text: lines.join('\n'),
    parseMode: 'HTML',
    disableWebPreview: true,
  };
}
