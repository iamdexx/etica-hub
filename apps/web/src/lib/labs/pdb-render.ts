/**
 * Render a real ESMFold structure (a PDB string) as a 3D cartoon-ribbon image,
 * the same visual style as the in-browser 3Dmol viewer (`cartoon: spectrum`).
 *
 * The Cα backbone is smoothed with a Catmull-Rom spline, oriented via PCA and
 * tilted into a 3/4 view, then drawn as a depth-shaded tube: far segments are
 * darker, near segments brighter, with a glossy highlight on the near face —
 * so a helix reads as a rainbow corkscrew and a loop as a flowing 3D ribbon.
 *
 * Two colour modes:
 *   spectrum — rainbow N→C (3Dmol default, the minted NFT look)
 *   plddt    — AlphaFold/ESMFold confidence bands
 *
 * Pure string output (no DOM/WebGL), so the identical render is produced
 * server-side for the NFT `image` and client-side in the research feed.
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

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function norm(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function matVec(m: number[][], v: Vec3): Vec3 {
  return [
    m[0]![0]! * v[0] + m[0]![1]! * v[1] + m[0]![2]! * v[2],
    m[1]![0]! * v[0] + m[1]![1]! * v[1] + m[1]![2]! * v[2],
    m[2]![0]! * v[0] + m[2]![1]! * v[1] + m[2]![2]! * v[2],
  ];
}

function powerIteration(m: number[][], seed: Vec3): { vec: Vec3; val: number } {
  let v = norm(seed);
  let val = 0;
  for (let i = 0; i < 80; i++) {
    const mv = matVec(m, v);
    const next = norm(mv);
    val = dot(mv, next);
    v = next;
  }
  return { vec: v, val };
}

/** Orthonormal principal-axis frame (e1 longest → e3 thinnest) + centroid. */
function pcaFrame(pts: CaPoint[]): { c: Vec3; e1: Vec3; e2: Vec3; e3: Vec3 } {
  const n = pts.length;
  const c: Vec3 = [0, 0, 0];
  for (const p of pts) {
    c[0] += p.x;
    c[1] += p.y;
    c[2] += p.z;
  }
  c[0] /= n;
  c[1] /= n;
  c[2] /= n;

  const cov = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const p of pts) {
    const d: Vec3 = [p.x - c[0], p.y - c[1], p.z - c[2]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i]![j]! += d[i] * d[j];
  }
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i]![j]! /= n;

  const a1 = powerIteration(cov, [1, 0.3, 0.1]);
  const e1 = a1.vec;
  const cov2 = cov.map((row, i) => row.map((val, j) => val - a1.val * e1[i]! * e1[j]!));
  const a2 = powerIteration(cov2, [0.1, 1, 0.3]);
  // Re-orthogonalise e2 against e1, then complete the right-handed frame.
  const proj = dot(a2.vec, e1);
  const e2 = norm([a2.vec[0] - proj * e1[0], a2.vec[1] - proj * e1[1], a2.vec[2] - proj * e1[2]]);
  const e3 = cross(e1, e2);
  return { c, e1, e2, e3 };
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** HSL (h∈[0,360), s,l∈[0,1]) → #rrggbb. */
function hslHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(1, s));
  l = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

interface SplineNode {
  u: number;
  v: number;
  d: number;
  f: number;
  plddt: number;
}

/** Catmull-Rom subdivision of the backbone for a smooth ribbon. */
function splineNodes(arr: SplineNode[], per: number): SplineNode[] {
  const n = arr.length;
  const get = (i: number): SplineNode => arr[Math.max(0, Math.min(n - 1, i))]!;
  const out: SplineNode[] = [];
  const interp = (p0: number, p1: number, p2: number, p3: number, t: number, t2: number, t3: number) =>
    0.5 *
    (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  for (let i = 0; i < n - 1; i++) {
    const p0 = get(i - 1);
    const p1 = get(i);
    const p2 = get(i + 1);
    const p3 = get(i + 2);
    for (let s = 0; s < per; s++) {
      const t = s / per;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push({
        u: interp(p0.u, p1.u, p2.u, p3.u, t, t2, t3),
        v: interp(p0.v, p1.v, p2.v, p3.v, t, t2, t3),
        d: interp(p0.d, p1.d, p2.d, p3.d, t, t2, t3),
        f: interp(p0.f, p1.f, p2.f, p3.f, t, t2, t3),
        plddt: interp(p0.plddt, p1.plddt, p2.plddt, p3.plddt, t, t2, t3),
      });
    }
  }
  out.push(arr[n - 1]!);
  return out;
}

export interface FoldRenderMeta {
  tokenId: string;
  title: string;
  scoreStr: string;
  seqLen: number;
  subtitle: string;
}

export interface RibbonRenderOpts {
  /** Canvas width in user units (default 800). */
  width?: number;
  /** Canvas height in user units (default 500). */
  height?: number;
  /** Left/right padding (default 60). */
  pad?: number;
  /** View yaw in degrees (rotation about the vertical axis, default 35). */
  yawDeg?: number;
  /** View pitch in degrees (default 20). */
  pitchDeg?: number;
  /** Spline samples per residue gap (default 14). */
  samplesPerSegment?: number;
  /** Backbone colouring (default 'spectrum'). */
  color?: 'spectrum' | 'plddt';
  /** Draw a flat dark background instead of the radial gradient. */
  solidBg?: boolean;
  /** When set, overlays NFT-card chrome (title, score, sequence footer). */
  meta?: FoldRenderMeta;
}

export interface RibbonRender {
  svg: string;
  residues: number;
  meanPlddt: number;
}

/**
 * Render the real Cα backbone as a 3D cartoon-ribbon SVG. Returns null when
 * there are too few Cα atoms to draw a meaningful backbone (caller falls back).
 */
export function buildRibbonSvg(pdb: string, opts: RibbonRenderOpts = {}): RibbonRender | null {
  const trace = parseCaTrace(pdb);
  if (trace.length < 4) return null;

  const W = opts.width ?? 800;
  const H = opts.height ?? 500;
  const PAD = opts.pad ?? 60;
  const mode = opts.color ?? 'spectrum';
  const yaw = ((opts.yawDeg ?? 35) * Math.PI) / 180;
  const pitch = ((opts.pitchDeg ?? 20) * Math.PI) / 180;
  const per = opts.samplesPerSegment ?? 14;
  const hasChrome = !!opts.meta;

  const { c, e1, e2, e3 } = pcaFrame(trace);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const n = trace.length;

  // PCA-align, then tilt into a 3/4 view; keep depth for shading.
  const raw: SplineNode[] = trace.map((p, i) => {
    const d: Vec3 = [p.x - c[0], p.y - c[1], p.z - c[2]];
    const a = dot(d, e1);
    const b = dot(d, e2);
    const cc = dot(d, e3);
    const a1 = a * cy + cc * sy;
    const c1 = -a * sy + cc * cy;
    const b2 = b * cp - c1 * sp;
    const c2 = b * sp + c1 * cp;
    return { u: a1, v: b2, d: c2, f: n > 1 ? i / (n - 1) : 0, plddt: p.plddt };
  });
  const pts = splineNodes(raw, per);

  const us = pts.map((p) => p.u);
  const vs = pts.map((p) => p.v);
  const ds = pts.map((p) => p.d);
  const minU = Math.min(...us);
  const maxU = Math.max(...us);
  const minV = Math.min(...vs);
  const maxV = Math.max(...vs);
  const minD = Math.min(...ds);
  const maxD = Math.max(...ds);
  const spanU = maxU - minU || 1;
  const spanV = maxV - minV || 1;
  const spanD = maxD - minD || 1;

  const topInset = hasChrome ? 104 : PAD;
  const botInset = hasChrome ? 76 : PAD;
  const drawW = W - PAD * 2;
  const drawH = H - topInset - botInset;
  const scale = Math.min(drawW / spanU, drawH / spanV);
  const offX = PAD + (drawW - spanU * scale) / 2;
  const offY = topInset + (drawH - spanV * scale) / 2;

  const screen = pts.map((p) => ({
    x: offX + (p.u - minU) * scale,
    y: offY + (maxV - p.v) * scale,
    dt: (p.d - minD) / spanD,
    f: p.f,
    plddt: p.plddt,
  }));

  // Tube width scales down as the chain gets longer (denser backbone).
  const baseW = Math.max(7, Math.min(20, 600 / Math.sqrt(n)));

  interface Seg {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    dt: number;
    f: number;
    plddt: number;
  }
  const segs: Seg[] = [];
  for (let i = 1; i < screen.length; i++) {
    const a = screen[i - 1]!;
    const b = screen[i]!;
    segs.push({
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      dt: (a.dt + b.dt) / 2,
      f: (a.f + b.f) / 2,
      plddt: (a.plddt + b.plddt) / 2,
    });
  }
  // Painter's algorithm: draw far (small depth) first so near segments occlude.
  segs.sort((p, q) => p.dt - q.dt);

  const line = (s: Seg, stroke: string, w: number, extra = '') =>
    `<line x1="${s.x1.toFixed(1)}" y1="${s.y1.toFixed(1)}" x2="${s.x2.toFixed(1)}" y2="${s.y2.toFixed(
      1,
    )}" stroke="${stroke}" stroke-width="${w.toFixed(1)}" stroke-linecap="round"${extra}/>`;

  const body: string[] = [];
  for (const s of segs) {
    const w = baseW * (0.82 + 0.36 * s.dt);
    let col: string;
    if (mode === 'plddt') {
      col = plddtColor(s.plddt);
    } else {
      const h = 248 - 248 * s.f; // blue (N) → red (C)
      const l = 0.4 + 0.26 * s.dt; // depth shading
      col = hslHex(h, 0.82, l);
    }
    // Dark casing then coloured core (interleaved → correct occlusion).
    body.push(line(s, '#02060c', w + 3, ' stroke-opacity="0.5"'));
    body.push(line(s, col, w));
  }
  // Glossy highlight along the near face.
  for (const s of segs) {
    if (s.dt < 0.55) continue;
    const w = baseW * (0.82 + 0.36 * s.dt) * 0.34;
    body.push(line(s, '#ffffff', w, ` stroke-opacity="${(0.1 + 0.16 * s.dt).toFixed(2)}"`));
  }

  const meanPlddt = trace.reduce((s, p) => s + p.plddt, 0) / trace.length;

  const defs: string[] = [];
  let bg: string;
  if (opts.solidBg) {
    bg = `<rect width="${W}" height="${H}" fill="#060c16"/>`;
  } else {
    defs.push(
      `<radialGradient id="rbg" cx="42%" cy="36%" r="82%"><stop offset="0%" stop-color="#0d1830"/><stop offset="100%" stop-color="#05080f"/></radialGradient>`,
    );
    bg = `<rect width="${W}" height="${H}" fill="url(#rbg)"/>`;
  }

  let chrome = '';
  if (opts.meta) {
    const m = opts.meta;
    defs.push(
      `<linearGradient id="spec" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#1f4ff0"/><stop offset="33%" stop-color="#19c3c9"/><stop offset="55%" stop-color="#3fd14d"/><stop offset="78%" stop-color="#ffd11a"/><stop offset="100%" stop-color="#ff3b30"/></linearGradient>`,
    );
    const legendX = W - PAD - 150;
    chrome =
      `<text x="${PAD}" y="44" fill="#7fd8ff" font-size="11" letter-spacing="5" opacity="0.85">ETICA RESEARCH NFT · ESMFold</text>` +
      `<text x="${PAD}" y="80" fill="#ffffff" font-size="28" font-weight="700">#${xmlEscape(m.tokenId)}</text>` +
      `<text x="${PAD}" y="100" fill="#cdd6f4" font-size="15">${xmlEscape(m.title)}</text>` +
      `<text x="${W - PAD}" y="76" fill="#7fd8ff" font-size="46" font-weight="700" text-anchor="end">${xmlEscape(
        m.scoreStr,
      )}</text>` +
      `<text x="${W - PAD}" y="96" fill="#7fd8ff" font-size="10" letter-spacing="2" text-anchor="end">FOLD CONFIDENCE</text>` +
      `<rect x="${PAD}" y="${H - 54}" width="${W - PAD * 2}" height="1" fill="#7fd8ff" opacity="0.2"/>` +
      `<text x="${PAD}" y="${H - 28}" fill="#9fb3c8" font-size="11">${m.seqLen} aa · ${trace.length} residues · mean pLDDT ${meanPlddt.toFixed(
        0,
      )} · ${xmlEscape(m.subtitle)}</text>` +
      `<text x="${legendX - 8}" y="${H - 24}" fill="#9fb3c8" font-size="11" text-anchor="end">N</text>` +
      `<rect x="${legendX}" y="${H - 33}" width="130" height="9" rx="4" fill="url(#spec)"/>` +
      `<text x="${legendX + 138}" y="${H - 24}" fill="#9fb3c8" font-size="11">C</text>`;
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" style="width:100%;height:100%;display:block" font-family="-apple-system,BlinkMacSystemFont,sans-serif">` +
    (defs.length ? `<defs>${defs.join('')}</defs>` : '') +
    bg +
    `<g>${body.join('')}</g>` +
    chrome +
    `</svg>`;

  return { svg, residues: trace.length, meanPlddt };
}
