/**
 * GET /api/labs/fold-render/[tokenId]
 *
 * Serves the protein fold visualization as an SVG image for NFT `image` field.
 * Reads the on-chain Discovery record and renders the protein structure
 * as a publication-quality data card showing the fold confidence, sequence,
 * and structural information.
 *
 * This replaces the old inline SVG with a server-rendered version that can
 * incorporate fold-quality heatmap data from the PDB when available.
 */

import { NextRequest } from 'next/server';
import type { Hex } from 'viem';

import { DEPLOYMENTS, eticaMainnet } from '@etica-hub/shared';
import { getResearchClient } from '@/lib/research';
import { getPdbForSequence } from '@/lib/labs/archive';
import { buildRibbonSvg } from '@/lib/labs/pdb-render';
import eticaResearchNftArtifact from '@/lib/etica-research-nft-artifact.json';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Discovery {
  parentGoalTitle: string;
  sequence: string;
  analysis: string;
  score: bigint;
  iterations: bigint;
  branchGoalId: string;
  submitter: string;
  discoveredAt: bigint;
  blockNumber: bigint;
}

function scoreDecimal(scoreBps: bigint): string {
  if (scoreBps >= 10_000n) return '1.00';
  const s = scoreBps.toString().padStart(4, '0');
  return `0.${s}`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '...';
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generates a protein fold visualization SVG.
 * Shows the structure as a confidence-colored backbone representation
 * with key metadata overlaid.
 */
function buildFoldSvg(tokenId: string, d: Discovery): string {
  const scoreStr = scoreDecimal(d.score);
  const scoreNum = Number(d.score) / 10_000;
  const seqLen = d.sequence.length;
  const seqPreview = truncate(d.sequence, 50);
  const titlePreview = truncate(d.parentGoalTitle, 55);

  // Color based on fold confidence score
  const hue = Math.round(scoreNum * 120); // 0 = red (low), 120 = green (high)
  const scoreColor = `hsl(${hue}, 80%, 55%)`;

  // Generate a simple backbone path from sequence length
  // This creates a visually appealing helix-like pattern
  const pathPoints: string[] = [];
  const residueCount = Math.min(seqLen, 200);
  const cx = 400;
  const cy = 250;
  for (let i = 0; i < residueCount; i++) {
    const t = i / residueCount;
    const angle = t * Math.PI * 8;
    const radius = 60 + t * 80;
    const x = cx + radius * Math.cos(angle) * (0.5 + 0.5 * Math.sin(t * Math.PI));
    const y = cy + radius * Math.sin(angle) * 0.4 - t * 60;
    pathPoints.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500" font-family="-apple-system,BlinkMacSystemFont,sans-serif">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#0a0e1a"/>
    <stop offset="100%" stop-color="#141e30"/>
  </linearGradient>
  <linearGradient id="fold" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="${scoreColor}" stop-opacity="0.9"/>
    <stop offset="100%" stop-color="${scoreColor}" stop-opacity="0.4"/>
  </linearGradient>
  <filter id="glow">
    <feGaussianBlur stdDeviation="3" result="blur"/>
    <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
</defs>
<rect width="800" height="500" fill="url(#bg)"/>
<polyline points="${pathPoints.join(' ')}" fill="none" stroke="url(#fold)" stroke-width="3" stroke-linecap="round" filter="url(#glow)" opacity="0.9"/>
${Array.from({ length: Math.min(residueCount, 40) }, (_, i) => {
  const idx = Math.floor((i / 40) * pathPoints.length);
  const pt = pathPoints[idx];
  if (!pt) return '';
  const [px, py] = pt.split(',');
  return `<circle cx="${px}" cy="${py}" r="3" fill="${scoreColor}" opacity="0.7"/>`;
}).join('\n')}
<text x="40" y="45" fill="#7fd8ff" font-size="11" letter-spacing="5" opacity="0.8">ETICA RESEARCH NFT</text>
<text x="40" y="80" fill="#ffffff" font-size="28" font-weight="700">#${xmlEscape(tokenId)}</text>
<text x="40" y="110" fill="#cdd6f4" font-size="16">${xmlEscape(titlePreview)}</text>
<rect x="40" y="400" width="720" height="1" fill="#7fd8ff" opacity="0.2"/>
<text x="40" y="430" fill="#7fd8ff" font-size="10" letter-spacing="3">SEQUENCE (${seqLen} aa)</text>
<text x="40" y="450" fill="#ffffff" font-size="13" font-family="monospace" opacity="0.9">${xmlEscape(seqPreview)}</text>
<text x="620" y="80" fill="${scoreColor}" font-size="48" font-weight="700" text-anchor="end">${scoreStr}</text>
<text x="620" y="100" fill="#7fd8ff" font-size="10" letter-spacing="2" text-anchor="end">FOLD CONFIDENCE</text>
<text x="700" y="470" fill="#7fd8ff" font-size="10" opacity="0.5" text-anchor="end">eticahub.com/labs</text>
<text x="40" y="470" fill="#7fd8ff" font-size="10" opacity="0.5">${d.iterations.toString()} iterations · block #${d.blockNumber.toString()}</text>
</svg>`;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ tokenId: string }> },
): Promise<Response> {
  const { tokenId } = await params;
  const id = parseInt(tokenId, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return new Response('Invalid token ID', { status: 400 });
  }

  const chainId = eticaMainnet.id;
  const nftAddress = DEPLOYMENTS[chainId].eticaResearchNft as Hex;
  if (!nftAddress || nftAddress === '0x0000000000000000000000000000000000000000') {
    return new Response('NFT contract not deployed', { status: 503 });
  }

  try {
    const client = getResearchClient();
    const raw = await client.readContract({
      abi: eticaResearchNftArtifact.abi,
      address: nftAddress,
      functionName: 'discoveryOf',
      args: [BigInt(id)],
    });

    const d = raw as unknown as Discovery;
    if (!d.sequence || d.sequence.length === 0) {
      return new Response('Token not found or has no sequence', { status: 404 });
    }

    // Prefer the real ESMFold structure: if we persisted a PDB for this
    // exact sequence, render the actual Cα backbone as a 3D cartoon ribbon
    // (rainbow N→C). Fall back to the stylised card for older tokens with no
    // stored structure.
    let svg: string | null = null;
    try {
      const pdb = await getPdbForSequence(d.sequence);
      if (pdb) {
        svg =
          buildRibbonSvg(pdb, {
            meta: {
              tokenId,
              title: truncate(d.parentGoalTitle, 55),
              scoreStr: scoreDecimal(d.score),
              seqLen: d.sequence.length,
              subtitle: `${d.iterations.toString()} iterations · block #${d.blockNumber.toString()}`,
            },
          })?.svg ?? null;
      }
    } catch {
      /* fall through to stylised card */
    }
    if (!svg) svg = buildFoldSvg(tokenId, d);

    return new Response(svg, {
      status: 200,
      headers: {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch (err) {
    return new Response(
      `Failed to read discovery: ${err instanceof Error ? err.message : 'unknown'}`,
      { status: 502 },
    );
  }
}
