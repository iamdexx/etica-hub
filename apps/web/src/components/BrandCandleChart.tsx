'use client';

import { useMemo, useState, type CSSProperties } from 'react';

/**
 * TradingView-style candle visualization in the EticaHub brand palette.
 *
 * Pure SVG — no charting lib — so it ships zero extra bundle. Renders an
 * OHLC price pane with subtle gridlines, brand-accented bull/bear bodies,
 * an optional volume row underneath, a price-axis on the right, a
 * time-axis along the bottom, and a crosshair tooltip on hover.
 *
 * Designed to be data-source-agnostic — the chart only needs OHLC tuples.
 * Callers feed it real candles from `/api/v1/ohlcv` or sample buckets
 * aggregated client-side from the on-chain reserve buffer.
 */
export type BrandCandle = {
  /** Unix timestamp in seconds for the start of the candle bucket. */
  t: number;
  /** Open price (quote per base, human units). */
  o: number;
  /** High price across the candle. */
  h: number;
  /** Low price across the candle. */
  l: number;
  /** Close price at the end of the candle. */
  c: number;
  /**
   * Optional volume — used to render the volume row when at least one
   * candle in the series has a positive value. Otherwise the volume row
   * is hidden and the price pane fills the full chart height.
   */
  volume?: number;
};

export interface BrandCandleChartProps {
  candles: BrandCandle[];
  /** Optional override for the SVG aspect ratio. Default 860×360. */
  width?: number;
  height?: number;
  /** Number-format hint. Default "auto" picks precision from magnitude. */
  precision?: number | 'auto';
  /**
   * Label suffix appended to price tick text (e.g. "ETX"). Helpful when
   * the chart is embedded without a separate base/quote header strip.
   */
  priceSuffix?: string;
  /**
   * Optional message overlaid on top of the chart canvas — used for
   * `loading…` / `no candles in this window` states without unmounting
   * the SVG (so the layout doesn't reflow as data trickles in).
   */
  overlay?: string | null;
  /** Brand bull color override. Default `#34d399`. */
  bullColor?: string;
  /** Brand bear color override. Default `#fb7185`. */
  bearColor?: string;
  className?: string;
  style?: CSSProperties;
}

const DEFAULT_BULL = '#34d399';
const DEFAULT_BEAR = '#fb7185';
const CANVAS_FILL = '#06110e';
const GRID_LINE = 'rgba(255,255,255,0.07)';
const AXIS_TEXT = 'rgba(255,255,255,0.42)';
const AXIS_TEXT_DIM = 'rgba(255,255,255,0.32)';
const CROSSHAIR = 'rgba(255,255,255,0.35)';

function pickPrecision(value: number, override: number | 'auto'): number {
  if (override !== 'auto') return override;
  if (!Number.isFinite(value) || value <= 0) return 4;
  if (value >= 1000) return 2;
  if (value >= 100) return 2;
  if (value >= 1) return 4;
  if (value >= 0.01) return 5;
  return 6;
}

function formatPriceValue(value: number, precision: number | 'auto'): string {
  if (!Number.isFinite(value)) return '—';
  return value.toFixed(pickPrecision(value, precision));
}

function formatVolume(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '0';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(2)}k`;
  return v.toFixed(2);
}

function formatTimeLabel(ts: number, spanSeconds: number): string {
  const d = new Date(ts * 1000);
  if (spanSeconds >= 86400 * 3) {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function BrandCandleChart({
  candles,
  width = 860,
  height = 360,
  precision = 'auto',
  priceSuffix,
  overlay,
  bullColor = DEFAULT_BULL,
  bearColor = DEFAULT_BEAR,
  className,
  style,
}: BrandCandleChartProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const layout = useMemo(() => {
    if (candles.length === 0) {
      return null;
    }
    const padL = 56;
    const padR = 56;
    const padT = 18;
    const padB = 32;
    const innerW = Math.max(60, width - padL - padR);
    const innerH = Math.max(40, height - padT - padB);
    const hasVolume = candles.some((c) => typeof c.volume === 'number' && c.volume > 0);
    const priceH = hasVolume ? Math.floor(innerH * 0.74) : innerH;
    const volTop = padT + priceH + 12;
    const volH = hasVolume ? Math.max(20, innerH - priceH - 12) : 0;

    let hi = -Infinity;
    let lo = Infinity;
    let maxVol = 0;
    for (const c of candles) {
      if (c.h > hi) hi = c.h;
      if (c.l < lo) lo = c.l;
      if (typeof c.volume === 'number' && c.volume > maxVol) maxVol = c.volume;
    }
    if (!Number.isFinite(hi) || !Number.isFinite(lo)) {
      hi = 1;
      lo = 0;
    }
    if (hi === lo) {
      const pad = Math.abs(hi) * 0.05 || 1;
      hi += pad;
      lo -= pad;
    }
    // Add 4% headroom so wicks don't kiss the canvas edges.
    const range = hi - lo;
    hi += range * 0.04;
    lo -= range * 0.04;
    const finalRange = Math.max(hi - lo, 1e-9);

    const step = innerW / Math.max(1, candles.length);
    const bodyW = Math.max(2, step * 0.62);

    const yFromPrice = (p: number) =>
      padT + priceH - ((p - lo) / finalRange) * priceH;
    const xFromIndex = (i: number) => padL + step * (i + 0.5);

    const firstTs = candles[0]?.t ?? 0;
    const lastTs = candles[candles.length - 1]?.t ?? firstTs;
    const span = Math.max(1, lastTs - firstTs);

    // Price-axis ticks — quarter divisions are dense enough to read range
    // without overcrowding small viewports.
    const priceTicks = [0, 0.25, 0.5, 0.75, 1].map((p) => ({
      y: padT + priceH * p,
      v: hi - finalRange * p,
    }));

    // Time-axis ticks — 4-6 anchor labels along the bottom depending on
    // candle count. Falls back to first/last when too few candles.
    const wantTicks = candles.length < 8 ? Math.min(candles.length, 2) : 5;
    const timeTickIdx: number[] = [];
    if (candles.length > 0) {
      if (wantTicks <= 1) {
        timeTickIdx.push(0);
      } else {
        for (let i = 0; i < wantTicks; i += 1) {
          const idx = Math.round((i * (candles.length - 1)) / (wantTicks - 1));
          timeTickIdx.push(idx);
        }
      }
    }

    return {
      padL,
      padR,
      padT,
      padB,
      innerW,
      priceH,
      volTop,
      volH,
      hasVolume,
      maxVol,
      hi,
      lo,
      step,
      bodyW,
      yFromPrice,
      xFromIndex,
      priceTicks,
      timeTickIdx,
      firstTs,
      lastTs,
      span,
    };
  }, [candles, width, height]);

  if (!layout) {
    return (
      <div
        className={`rounded-xl border border-white/10 bg-[#06110e] p-10 text-center text-sm text-white/45 ${className ?? ''}`}
        style={style}
      >
        {overlay ?? 'No candle data in this window.'}
      </div>
    );
  }

  const {
    padL,
    padT,
    padB,
    innerW,
    priceH,
    volTop,
    volH,
    hasVolume,
    maxVol,
    step,
    bodyW,
    yFromPrice,
    xFromIndex,
    priceTicks,
    timeTickIdx,
    span,
  } = layout;

  const hovered = hoverIdx !== null ? candles[hoverIdx] : null;
  const latest = candles[candles.length - 1]!;
  const latestY = yFromPrice(latest.c);
  const latestBull = latest.c >= latest.o;

  return (
    <div className={className} style={style}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        role="img"
        aria-label="OHLC market candles"
        className="block touch-none select-none"
        preserveAspectRatio="none"
      >
        <rect x="0" y="0" width={width} height={height} fill={CANVAS_FILL} />

        {/* Price gridlines + right-axis labels. */}
        {priceTicks.map((tick, i) => (
          <g key={`pt-${i}`}>
            <line
              x1={padL}
              x2={width - 56 + 48}
              y1={tick.y}
              y2={tick.y}
              stroke={GRID_LINE}
            />
            <text
              x={width - 8}
              y={tick.y + 3}
              textAnchor="end"
              fill={AXIS_TEXT}
              fontSize="10"
              fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
            >
              {formatPriceValue(tick.v, precision)}
              {priceSuffix ? ` ${priceSuffix}` : ''}
            </text>
          </g>
        ))}

        {/* Candles. */}
        {candles.map((c, i) => {
          const up = c.c >= c.o;
          const stroke = up ? bullColor : bearColor;
          const bodyTop = yFromPrice(Math.max(c.o, c.c));
          const bodyBottom = yFromPrice(Math.min(c.o, c.c));
          const bodyH = Math.max(1, bodyBottom - bodyTop);
          const cx = xFromIndex(i);
          return (
            <g key={`c-${i}-${c.t}`}>
              <line
                x1={cx}
                x2={cx}
                y1={yFromPrice(c.h)}
                y2={yFromPrice(c.l)}
                stroke={stroke}
                strokeWidth="1.3"
              />
              <rect
                x={cx - bodyW / 2}
                y={bodyTop}
                width={bodyW}
                height={bodyH}
                rx="1.4"
                fill={up ? bullColor : bearColor}
                fillOpacity={up ? 0.9 : 0.92}
              />
              {hasVolume && typeof c.volume === 'number' && c.volume > 0 ? (
                (() => {
                  const vh = Math.max(1, (c.volume / Math.max(1, maxVol)) * volH);
                  return (
                    <rect
                      x={cx - bodyW / 2}
                      y={volTop + (volH - vh)}
                      width={bodyW}
                      height={vh}
                      rx="1"
                      fill={up ? bullColor : bearColor}
                      fillOpacity={up ? 0.28 : 0.32}
                    />
                  );
                })()
              ) : null}
              {/* Wide invisible hover hit-target — one strip per candle so
                  hover snaps cleanly even with thin bodies. */}
              <rect
                x={cx - step / 2}
                y={padT}
                width={step}
                height={priceH + (hasVolume ? volH + 12 : 0)}
                fill="transparent"
                onMouseEnter={() => setHoverIdx(i)}
                onMouseMove={() => setHoverIdx(i)}
                onMouseLeave={() => setHoverIdx((curr) => (curr === i ? null : curr))}
                onTouchStart={() => setHoverIdx(i)}
              />
            </g>
          );
        })}

        {/* Time-axis labels along the bottom. */}
        {timeTickIdx.map((idx) => {
          const c = candles[idx];
          if (!c) return null;
          const x = xFromIndex(idx);
          return (
            <text
              key={`tt-${idx}`}
              x={x}
              y={padT + priceH + (hasVolume ? volH + 24 : padB - 12)}
              textAnchor="middle"
              fill={AXIS_TEXT_DIM}
              fontSize="10"
              fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
            >
              {formatTimeLabel(c.t, span)}
            </text>
          );
        })}

        {/* Volume label. */}
        {hasVolume ? (
          <text
            x={padL}
            y={volTop - 4}
            fill={AXIS_TEXT_DIM}
            fontSize="9"
            fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
          >
            VOLUME
          </text>
        ) : null}

        {/* Last-price marker. */}
        <g>
          <line
            x1={padL}
            x2={width - 56}
            y1={latestY}
            y2={latestY}
            stroke={latestBull ? bullColor : bearColor}
            strokeOpacity="0.6"
            strokeWidth="1"
            strokeDasharray="3 3"
          />
          <rect
            x={width - 56}
            y={latestY - 9}
            width={52}
            height={18}
            rx="3"
            fill={latestBull ? bullColor : bearColor}
            fillOpacity="0.85"
          />
          <text
            x={width - 30}
            y={latestY + 4}
            textAnchor="middle"
            fill="#06110e"
            fontSize="10"
            fontWeight={600}
            fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
          >
            {formatPriceValue(latest.c, precision)}
          </text>
        </g>

        {/* Crosshair + tooltip when hovering. */}
        {hovered != null && hoverIdx !== null ? (
          (() => {
            const cx = xFromIndex(hoverIdx);
            const cy = yFromPrice(hovered.c);
            const boxW = 168;
            const boxH = hasVolume ? 102 : 88;
            const wantsRight = cx + 14 + boxW > width;
            const boxX = wantsRight ? cx - 14 - boxW : cx + 14;
            const boxY = Math.min(Math.max(padT + 4, cy - boxH / 2), padT + priceH - boxH - 4);
            const dt = new Date(hovered.t * 1000);
            const dateStr = dt.toLocaleString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            });
            return (
              <g pointerEvents="none">
                <line
                  x1={cx}
                  x2={cx}
                  y1={padT}
                  y2={padT + priceH + (hasVolume ? volH + 12 : 0)}
                  stroke={CROSSHAIR}
                  strokeDasharray="2 3"
                  strokeWidth="1"
                />
                <line
                  x1={padL}
                  x2={width - 56}
                  y1={cy}
                  y2={cy}
                  stroke={CROSSHAIR}
                  strokeDasharray="2 3"
                  strokeWidth="1"
                />
                <rect
                  x={boxX}
                  y={boxY}
                  width={boxW}
                  height={boxH}
                  rx="6"
                  fill="rgba(6,17,14,0.94)"
                  stroke="rgba(255,255,255,0.12)"
                />
                <text
                  x={boxX + 10}
                  y={boxY + 16}
                  fill="rgba(255,255,255,0.7)"
                  fontSize="10"
                  fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                >
                  {dateStr}
                </text>
                {(
                  [
                    ['O', hovered.o],
                    ['H', hovered.h],
                    ['L', hovered.l],
                    ['C', hovered.c],
                  ] as const
                ).map(([label, value], j) => (
                  <text
                    key={label}
                    x={boxX + 10}
                    y={boxY + 34 + j * 13}
                    fill="rgba(255,255,255,0.85)"
                    fontSize="10.5"
                    fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                  >
                    <tspan fill="rgba(255,255,255,0.5)">{label} </tspan>
                    {formatPriceValue(value, precision)}
                  </text>
                ))}
                {hasVolume && typeof hovered.volume === 'number' ? (
                  <text
                    x={boxX + 10}
                    y={boxY + 34 + 4 * 13}
                    fill="rgba(255,255,255,0.85)"
                    fontSize="10.5"
                    fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                  >
                    <tspan fill="rgba(255,255,255,0.5)">V </tspan>
                    {formatVolume(hovered.volume)}
                  </text>
                ) : null}
              </g>
            );
          })()
        ) : null}

        {/* Overlay layer (loading / empty / error). */}
        {overlay ? (
          <g pointerEvents="none">
            <rect x="0" y="0" width={width} height={height} fill="rgba(6,17,14,0.55)" />
            <text
              x={width / 2}
              y={height / 2}
              textAnchor="middle"
              fill="rgba(255,255,255,0.7)"
              fontSize="13"
            >
              {overlay}
            </text>
          </g>
        ) : null}
      </svg>
    </div>
  );
}
