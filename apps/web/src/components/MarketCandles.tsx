export type CandlePoint = {
  t: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

function money(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(2)}k`;
  return `$${value.toFixed(value < 1 ? 6 : 2)}`;
}

export function MarketCandles({
  candles,
  width = 860,
  height = 320,
}: {
  candles: CandlePoint[];
  width?: number;
  height?: number;
}) {
  if (candles.length === 0) {
    return <div className="rounded-lg border border-white/10 bg-white/[0.02] p-5 text-sm text-white/45">No candle data available.</div>;
  }

  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);
  const hi = Math.max(...highs);
  const lo = Math.min(...lows);
  const range = Math.max(hi - lo, 1e-9);
  const maxVol = Math.max(1, ...volumes);

  const padL = 58;
  const padR = 18;
  const padT = 22;
  const padB = 74;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const volTop = padT + innerH + 18;
  const volH = height - volTop - 24;
  const step = candles.length > 1 ? innerW / candles.length : innerW;
  const candleW = Math.max(3, step * 0.58);
  const y = (price: number) => padT + innerH * (1 - (price - lo) / range);
  const x = (i: number) => padL + step * i + step / 2;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((p) => ({ y: padT + innerH * p, v: hi - range * p }));
  const latest = candles[candles.length - 1];
  const positive = latest.close >= latest.open;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label="OHLC market candles" className="block">
      <rect x="0" y="0" width={width} height={height} fill="#06110e" />
      {ticks.map((tick, i) => (
        <g key={i}>
          <line x1={padL} x2={width - padR} y1={tick.y} y2={tick.y} stroke="rgba(255,255,255,0.07)" />
          <text x={padL - 9} y={tick.y + 4} textAnchor="end" fill="rgba(255,255,255,0.42)" fontSize="10">{money(tick.v)}</text>
        </g>
      ))}
      {candles.map((c, i) => {
        const up = c.close >= c.open;
        const cx = x(i);
        const bodyTop = y(Math.max(c.open, c.close));
        const bodyBottom = y(Math.min(c.open, c.close));
        const bodyH = Math.max(1, bodyBottom - bodyTop);
        const volHeight = Math.max(1, (c.volume / maxVol) * volH);
        return (
          <g key={`${c.t}-${i}`}>
            <line x1={cx} x2={cx} y1={y(c.high)} y2={y(c.low)} stroke={up ? '#6ee7b7' : '#fb7185'} strokeWidth="1.4" />
            <rect x={cx - candleW / 2} y={bodyTop} width={candleW} height={bodyH} rx="1.5" fill={up ? 'rgba(52,211,153,0.78)' : 'rgba(251,113,133,0.78)'} />
            <rect x={cx - candleW / 2} y={volTop + (volH - volHeight)} width={candleW} height={volHeight} rx="1" fill={up ? 'rgba(52,211,153,0.22)' : 'rgba(251,113,133,0.22)'} />
            <rect x={cx - step / 2} y={padT} width={step} height={volTop + volH - padT} fill="transparent">
              <title>{`${c.t}\nOpen ${money(c.open)}\nHigh ${money(c.high)}\nLow ${money(c.low)}\nClose ${money(c.close)}\nVolume ${money(c.volume)}`}</title>
            </rect>
          </g>
        );
      })}
      <text x={padL} y={volTop - 6} fill="rgba(255,255,255,0.38)" fontSize="10">volume</text>
      <text x={width - padR} y={padT - 8} textAnchor="end" fill={positive ? '#6ee7b7' : '#fb7185'} fontSize="10">last {money(latest.close)}</text>
    </svg>
  );
}

export function demoCandles(seed = 1): CandlePoint[] {
  let price = 0.013 + seed * 0.002;
  return Array.from({ length: 36 }, (_, i) => {
    const drift = Math.sin((i + seed) / 4) * 0.0012;
    const open = price;
    const close = Math.max(0.0001, open + drift + (i % 5 - 2) * 0.00018);
    const high = Math.max(open, close) * (1 + 0.015 + (i % 4) * 0.003);
    const low = Math.min(open, close) * (1 - 0.012 - (i % 3) * 0.002);
    const volume = 9000 + ((i * 7919 + seed * 313) % 28000);
    price = close;
    return { t: `${i + 1}`, open, high, low, close, volume };
  });
}
