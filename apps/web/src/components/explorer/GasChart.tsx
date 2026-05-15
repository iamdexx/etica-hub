import { formatGwei, type GasBlockStat } from '@/lib/gas';

/**
 * Server-rendered EticaHub market-style chart for gas/base-fee analytics.
 *
 * This intentionally stays dependency-free and zero-client-JS, but renders
 * more like a real market panel: grid, axis labels, area curve, utilization
 * bars, hover columns, and min/max markers.
 */
export function GasChart({
  blocks,
  width = 920,
  height = 280,
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

  const fees = blocks.map((b) => Number(b.baseFeePerGasWei ?? 0n));
  const ratios = blocks.map((b) =>
    b.gasLimit > 0n ? Number(b.gasUsed) / Number(b.gasLimit) : 0,
  );

  const minFee = Math.min(...fees);
  const maxFee = Math.max(1, ...fees);
  const feeRange = Math.max(1, maxFee - minFee);

  const padL = 54;
  const padR = 22;
  const padT = 24;
  const padB = 72;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const step = blocks.length > 1 ? innerW / (blocks.length - 1) : 0;
  const chartBottom = padT + innerH;

  const yForFee = (fee: number) => padT + innerH * (1 - (fee - minFee) / feeRange);
  const points = blocks.map((_, i) => ({
    x: padL + step * i,
    y: yForFee(fees[i]),
  }));

  const linePath = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(' ');
  const areaPath = `${linePath} L${points[points.length - 1].x.toFixed(1)},${chartBottom.toFixed(1)} L${points[0].x.toFixed(1)},${chartBottom.toFixed(1)} Z`;

  const barTop = chartBottom + 18;
  const barH = height - barTop - 26;
  const barW = Math.max(2, (step || innerW) * 0.56);

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const fee = minFee + feeRange * t;
    return { fee, y: yForFee(fee) };
  });
  const xTickIndexes = Array.from(new Set([0, Math.floor(blocks.length / 3), Math.floor((blocks.length * 2) / 3), blocks.length - 1])).filter((i) => i >= 0);
  const maxIndex = fees.indexOf(maxFee);
  const minIndex = fees.indexOf(minFee);

  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-[#06110e]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-white/[0.025] px-4 py-3">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-emerald-300/70">Base fee / network load</div>
          <div className="mt-1 text-sm font-semibold text-white">Etica Gas Market</div>
        </div>
        <div className="flex gap-2 text-[11px] text-white/50">
          <span className="rounded-md border border-emerald-400/20 bg-emerald-400/10 px-2 py-1 text-emerald-200">max {formatGwei(BigInt(Math.trunc(maxFee)))} gwei</span>
          <span className="rounded-md border border-white/10 bg-white/5 px-2 py-1">min {formatGwei(BigInt(Math.trunc(minFee)))} gwei</span>
        </div>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        role="img"
        aria-label={`Base fee and utilization over last ${blocks.length} blocks`}
        className="block"
      >
        <defs>
          <linearGradient id="gasArea" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="rgba(52,211,153,0.32)" />
            <stop offset="72%" stopColor="rgba(52,211,153,0.055)" />
            <stop offset="100%" stopColor="rgba(52,211,153,0)" />
          </linearGradient>
          <linearGradient id="gasLine" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="#6ee7b7" />
            <stop offset="100%" stopColor="#22c55e" />
          </linearGradient>
        </defs>

        <rect x="0" y="0" width={width} height={height} fill="#06110e" />
        {yTicks.map((tick, i) => (
          <g key={i}>
            <line x1={padL} x2={width - padR} y1={tick.y} y2={tick.y} stroke="rgba(255,255,255,0.07)" />
            <text x={padL - 10} y={tick.y + 4} textAnchor="end" fill="rgba(255,255,255,0.42)" fontSize="10">
              {formatGwei(BigInt(Math.trunc(tick.fee)))}
            </text>
          </g>
        ))}
        {xTickIndexes.map((i) => (
          <g key={i}>
            <line x1={points[i].x} x2={points[i].x} y1={padT} y2={barTop + barH} stroke="rgba(255,255,255,0.045)" />
            <text x={points[i].x} y={height - 9} textAnchor="middle" fill="rgba(255,255,255,0.38)" fontSize="10">
              #{blocks[i].number.toString()}
            </text>
          </g>
        ))}

        <path d={areaPath} fill="url(#gasArea)" />
        <path d={linePath} stroke="url(#gasLine)" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />

        {[minIndex, maxIndex].map((i) => (
          <g key={i}>
            <circle cx={points[i].x} cy={points[i].y} r="4" fill="#06110e" stroke="#6ee7b7" strokeWidth="2" />
          </g>
        ))}

        {blocks.map((b, i) => {
          const ratio = ratios[i];
          const bh = Math.max(1, barH * ratio);
          const x = points[i].x;
          return (
            <g key={b.number.toString()}>
              <rect x={x - barW / 2} y={barTop + (barH - bh)} width={barW} height={bh} rx="1.5" fill={ratio > 0.72 ? 'rgba(52,211,153,0.48)' : 'rgba(255,255,255,0.18)'} />
              <rect x={x - Math.max(step / 2, 3)} y={padT} width={Math.max(step, 6)} height={barTop + barH - padT} fill="transparent">
                <title>{`Block #${b.number.toString()}\nBase fee: ${formatGwei(b.baseFeePerGasWei)} gwei\nNetwork load: ${(ratio * 100).toFixed(1)}%\nTransactions: ${b.txCount}`}</title>
              </rect>
            </g>
          );
        })}

        <text x={padL} y={barTop - 5} fill="rgba(255,255,255,0.38)" fontSize="10">gas used / limit</text>
        <text x={width - padR} y={padT - 8} textAnchor="end" fill="rgba(52,211,153,0.82)" fontSize="10">base fee gwei</text>
      </svg>
    </div>
  );
}