/**
 * Render a real ESMFold structure (a PDB string) to an SVG Cα-backbone
 * trace, coloured per-residue by pLDDT confidence (the value ESMFold writes
 * into the B-factor column).
 *
 * The 2D layout is the structure's best view: we project the Cα coordinates
 * onto their top-2 principal axes (PCA via power iteration), so the trace
 * spreads across the canvas instead of collapsing onto an arbitrary plane.
 *
 * Colour scheme matches the AlphaFold/ESMFold pLDDT convention:
 *   ≥90 very high (dark blue) · 70–90 confident (cyan) ·
 *   50–70 low (yellow) · <50 very low (orange)
 */

export interface CaPoint {
  x: number;
  y: number;
  z: number;
  plddt: number;
}

/** Parse the Cα trace (coordinates + pLDDT) out of a PDB string. */
export function parseCaTrace(pdb: string): CaPoint[] {
  const pts: CaPoint[] = [];
  for (const line of pdb.split('\n')) {
    // Only first model — stop at ENDMDL so multi-model PDBs don't stack.
    if (line.startsWith('ENDMDL')) break;
    if (!line.startsWith('ATOM')) continue;
    if (line.slice(12, 16).trim() !== 'CA') continue;
    const x = Number.parseFloat(line.slice(30, 38));
    const y = Number.parseFloat(line.slice(38, 46));
    const z = Number.parseFloat(line.slice(46, 54));
    const b = Number.parseFloat(line.slice(60, 66));
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    pts.push({ x, y, z, plddt: Number.isFinite(b) ? b : 50 });
  }
  // ESMFold sometimes emits pLDDT on a 0–1 scale; normalise to 0–100.
  const maxB = pts.reduce((m, p) => Math.max(m, p.plddt), 0);
  if (maxB > 0 && maxB <= 1) for (const p of pts) p.plddt *= 100;
  return pts;
}

/**
 * Reduce a full-atom PDB to just its first-model Cα ATOM lines. The
 * fold-render only needs Cα coordinates + pLDDT (B-factor), so storing the
 * Cα-only trace keeps the whole backbone well under the persistence cap
 * (full-atom PDBs are ~8× larger and get truncated mid-structure).
 */
export function extractCaPdb(pdb: string): string {
  const out: string[] = [];
  for (const line of pdb.split('\n')) {
    if (line.startsWith('ENDMDL')) break;
    if (line.startsWith('ATOM') && line.slice(12, 16).trim() === 'CA') out.push(line);
  }
  return out.join('\n');
}

/** pLDDT → hex colour (AlphaFold/ESMFold convention). */
export function plddtColor(plddt: number): string {
  if (plddt >= 90) return '#0053d6';
  if (plddt >= 70) return '#65cbf3';
  if (plddt >= 50) return '#ffdb13';
  return '#ff7d45';
}

/* ---- tiny 3×3 PCA via power iteration (no deps) ---- */

type Vec3 = [number, number, number];

function matVec(m: number[][], v: Vec3): Vec3 {
  return [
    m[0]![0]! * v[0] + m[0]![1]! * v[1] + m[0]![2]! * v[2],
    m[1]![0]! * v[0] + m[1]![1]! * v[1] + m[1]![2]! * v[2],
    m[2]![0]! * v[0] + m[2]![1]! * v[1] + m[2]![2]! * v[2],
  ];
}

function norm(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function powerIteration(m: number[][], seed: Vec3): { vec: Vec3; val: number } {
  let v = norm(seed);
  let val = 0;
  for (let i = 0; i < 64; i++) {
    const mv = matVec(m, v);
    const next = norm(mv);
    val = mv[0] * next[0] + mv[1] * next[1] + mv[2] * next[2];
    v = next;
  }
  return { vec: v, val };
}

/** Project Cα points onto their two principal axes → centred 2D coords. */
function principalProjection(pts: CaPoint[]): Array<{ u: number; v: number; plddt: number }> {
  const n = pts.length;
  const cx = pts.reduce((s, p) => s + p.x, 0) / n;
  const cy = pts.reduce((s, p) => s + p.y, 0) / n;
  const cz = pts.reduce((s, p) => s + p.z, 0) / n;

  // Covariance matrix of centred coords.
  const cov = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const p of pts) {
    const d: Vec3 = [p.x - cx, p.y - cy, p.z - cz];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i]![j]! += d[i] * d[j];
  }
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i]![j]! /= n;

  const a1 = powerIteration(cov, [1, 0.3, 0.1]);
  // Deflate the dominant component, then extract the second axis.
  const l1 = a1.val;
  const e1 = a1.vec;
  const cov2 = cov.map((row, i) => row.map((val, j) => val - l1 * e1[i]! * e1[j]!));
  const a2 = powerIteration(cov2, [0.1, 1, 0.3]);
  const e2 = a2.vec;

  return pts.map((p) => {
    const d: Vec3 = [p.x - cx, p.y - cy, p.z - cz];
    return {
      u: d[0] * e1[0] + d[1] * e1[1] + d[2] * e1[2],
      v: d[0] * e2[0] + d[1] * e2[1] + d[2] * e2[2],
      plddt: p.plddt,
    };
  });
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface FoldRenderMeta {
  tokenId: string;
  title: string;
  scoreStr: string;
  seqLen: number;
  subtitle: string;
}

export interface CaTraceSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
}

export interface CaTraceNode {
  x: number;
  y: number;
  color: string;
}

export interface CaTraceLayout {
  width: number;
  height: number;
  segments: CaTraceSegment[];
  nodes: CaTraceNode[];
  meanPlddt: number;
  residues: number;
}

export interface CaTraceLayoutOpts {
  /** Canvas width in user units (default 800). */
  width?: number;
  /** Canvas height in user units (default 500). */
  height?: number;
  /** Padding around the trace (default 70). */
  pad?: number;
  /** Vertical space reserved at the bottom for footer chrome (default 40). */
  footer?: number;
  /** Extra downward offset to clear header chrome (default 20). */
  offsetY?: number;
  /** Max residue node markers to emit (default 60). */
  maxNodes?: number;
}

/**
 * Project a PDB's Cα trace into 2D drawing coordinates (segments + nodes),
 * coloured per-residue by pLDDT. Framework-agnostic: used by the server SVG
 * renderer and by the client feed card (rendered as real React <svg> nodes,
 * so it never touches WebGL and renders identically for every candidate).
 * Returns null if there are too few Cα atoms to draw a meaningful backbone.
 */
export function buildCaTraceLayout(
  pdb: string,
  opts: CaTraceLayoutOpts = {},
): CaTraceLayout | null {
  const trace = parseCaTrace(pdb);
  if (trace.length < 3) return null;

  const W = opts.width ?? 800;
  const H = opts.height ?? 500;
  const PAD = opts.pad ?? 70;
  const footer = opts.footer ?? 40;
  const offsetY = opts.offsetY ?? 20;
  const maxNodes = opts.maxNodes ?? 60;

  const proj = principalProjection(trace);

  // Fit projected coords into the drawing area.
  const drawW = W - PAD * 2;
  const drawH = H - PAD * 2 - footer;
  const us = proj.map((p) => p.u);
  const vs = proj.map((p) => p.v);
  const minU = Math.min(...us);
  const maxU = Math.max(...us);
  const minV = Math.min(...vs);
  const maxV = Math.max(...vs);
  const spanU = maxU - minU || 1;
  const spanV = maxV - minV || 1;
  const scale = Math.min(drawW / spanU, drawH / spanV);
  // Centre within the canvas.
  const offX = PAD + (drawW - spanU * scale) / 2;
  const offY = PAD + offsetY + (drawH - spanV * scale) / 2;

  const pixels = proj.map((p) => ({
    x: offX + (p.u - minU) * scale,
    y: offY + (p.v - minV) * scale,
    plddt: p.plddt,
  }));

  // Backbone segments coloured by the mean pLDDT of their endpoints.
  const segments: CaTraceSegment[] = [];
  for (let i = 1; i < pixels.length; i++) {
    const a = pixels[i - 1]!;
    const b = pixels[i]!;
    segments.push({
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      color: plddtColor((a.plddt + b.plddt) / 2),
    });
  }

  // Sparse residue nodes (cap to keep the output light).
  const step = Math.max(1, Math.floor(pixels.length / maxNodes));
  const nodes: CaTraceNode[] = [];
  for (let i = 0; i < pixels.length; i += step) {
    const p = pixels[i]!;
    nodes.push({ x: p.x, y: p.y, color: plddtColor(p.plddt) });
  }

  const meanPlddt = trace.reduce((s, p) => s + p.plddt, 0) / trace.length;

  return { width: W, height: H, segments, nodes, meanPlddt, residues: trace.length };
}

/**
 * Render the real Cα trace to an 800×500 SVG. Returns null if the PDB has
 * too few Cα atoms to draw a meaningful backbone (caller falls back).
 */
export function renderFoldTraceSvg(pdb: string, meta: FoldRenderMeta): string | null {
  const layout = buildCaTraceLayout(pdb);
  if (!layout) return null;

  const W = layout.width;
  const H = layout.height;

  const segments = layout.segments.map(
    (s) =>
      `<line x1="${s.x1.toFixed(1)}" y1="${s.y1.toFixed(1)}" x2="${s.x2.toFixed(
        1,
      )}" y2="${s.y2.toFixed(1)}" stroke="${s.color}" stroke-width="3.5" stroke-linecap="round"/>`,
  );

  const nodes = layout.nodes.map(
    (n) =>
      `<circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="2.4" fill="${n.color}"/>`,
  );

  const meanPlddt = layout.meanPlddt;

  // Confidence legend.
  const legend = [
    { c: '#0053d6', label: 'Very high' },
    { c: '#65cbf3', label: 'Confident' },
    { c: '#ffdb13', label: 'Low' },
    { c: '#ff7d45', label: 'Very low' },
  ]
    .map((seg, i) => {
      const lx = 300 + i * 120;
      return `<rect x="${lx}" y="462" width="12" height="12" rx="2" fill="${seg.c}"/><text x="${
        lx + 18
      }" y="472" fill="#9fb3c8" font-size="10">${seg.label}</text>`;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="-apple-system,BlinkMacSystemFont,sans-serif">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#070d18"/>
    <stop offset="100%" stop-color="#0f1b2e"/>
  </linearGradient>
  <filter id="glow"><feGaussianBlur stdDeviation="2.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
</defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>
<g filter="url(#glow)">
${segments.join('\n')}
</g>
${nodes.join('\n')}
<text x="40" y="44" fill="#7fd8ff" font-size="11" letter-spacing="5" opacity="0.8">ETICA RESEARCH NFT · ESMFold Cα</text>
<text x="40" y="80" fill="#ffffff" font-size="28" font-weight="700">#${xmlEscape(meta.tokenId)}</text>
<text x="40" y="106" fill="#cdd6f4" font-size="15">${xmlEscape(meta.title)}</text>
<text x="760" y="80" fill="#7fd8ff" font-size="46" font-weight="700" text-anchor="end">${xmlEscape(
    meta.scoreStr,
  )}</text>
<text x="760" y="100" fill="#7fd8ff" font-size="10" letter-spacing="2" text-anchor="end">FOLD CONFIDENCE</text>
<rect x="40" y="446" width="720" height="1" fill="#7fd8ff" opacity="0.2"/>
<text x="40" y="472" fill="#9fb3c8" font-size="11">${meta.seqLen} aa · mean pLDDT ${meanPlddt.toFixed(
    0,
  )} · ${xmlEscape(meta.subtitle)}</text>
${legend}
</svg>`;
}
