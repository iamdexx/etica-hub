import { formatGwei, type GasBlockStat } from '@/lib/gas';

/**
 * Inline server-rendered SVG sparkline for a GasBlockStat series.
 *
 * Renders base fee (gwei) as a filled area and gas-used / gas-limit as
 * a light bar under each block. Kept zero-JS by emitting raw SVG at
 * render time — the explorer is read-first and we don't need
 * interactivity beyond native tooltips.
 *
 * Tooltip: each data point's invisible hit area carries a `<title>`
 * with block number + base fee + usage so hovering on the SVG gives
 * per-block context without shipping a charting library.
 */
export function GasChart({
  blocks,
  width = 720,
  height = 160,
}: {
  blocks: ReadonlyArray<GasBlockStat>;
  width?: number;
  height?: number;
}) {
  if (blocks.length === 0) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-5 text-sm text-white/50">
        No block data available for the gas window.
      </div>
    );
  }

  // Data-space. `fees` may contain zeros if the chain is pre-1559; we
  // still render the usage bars so the chart isn't empty.
  const fees = blocks.map((b) => Number(b.baseFeePerGasWei ?? 0n));
  const ratios = blocks.map((b) =>
    b.gasLimit > 0n ? Number(b.gasUsed) / Number(b.gasLimit) : 0,
  );
  const maxFee = Math.max(1, ...fees);

  // Screen-space.
  const padX = 8;
  const padTop = 4;
  const padBottom = 20; // leave room for the usage-ratio bars
  const innerW = width - padX * 2;
  const innerH = height - padTop - padBottom;
  const step = blocks.length > 1 ? innerW / (blocks.length - 1) : 0;

  const points = blocks.map((_, i) => {
    const x = padX + step * i;
    const y = padTop + innerH * (1 - fees[i] / maxFee);
    return { x, y };
  });

  const linePath = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(' ');
  const areaPath =
    linePath +
    ` L${points[points.length - 1].x.toFixed(1)},${(padTop + innerH).toFixed(1)}` +
    ` L${points[0].x.toFixed(1)},${(padTop + innerH).toFixed(1)} Z`;

  // Usage bars: one narrow bar per block in the bottom gutter.
  const barW = Math.max(1, step * 0.6);
  const barTrackY = padTop + innerH + 4;
  const barTrackH = padBottom - 6;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      role="img"
      aria-label={`Base fee over last ${blocks.length} blocks`}
      className="block"
    >
      <path d={areaPath} fill="rgba(52,211,153,0.15)" />
      <path d={linePath} stroke="#34d399" strokeWidth={1.5} fill="none" />
      {blocks.map((b, i) => {
        const { x } = points[i];
        const r = ratios[i];
        const bh = Math.max(1, barTrackH * r);
        const by = barTrackY + (barTrackH - bh);
        return (
          <g key={b.number.toString()}>
            <rect
              x={x - barW / 2}
              y={by}
              width={barW}
              height={bh}
              fill="rgba(255,255,255,0.18)"
            />
            {/* Transparent hit area so the native tooltip works across
                the full column, not just the 1px line. */}
            <rect
              x={x - step / 2}
              y={padTop}
              width={step || 2}
              height={innerH + padBottom}
              fill="transparent"
            >
              <title>
                {`#${b.number.toString()} · ${formatGwei(b.baseFeePerGasWei)} gwei · ${(r * 100).toFixed(0)}% full · ${b.txCount} tx`}
              </title>
            </rect>
          </g>
        );
      })}
    </svg>
  );
}
