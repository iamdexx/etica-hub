import { ImageResponse } from 'next/og';

import { getArchivedResearch } from '@/lib/labs/archive';
import { discoveryDescription, discoveryTitle } from '@/lib/labs/discovery-meta';
import { scoreLabel } from '@/lib/labs/plain-summary';

export const runtime = 'nodejs';
export const alt = 'EticaHub Labs discovery';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await getArchivedResearch(id);

  const title = r ? discoveryTitle(r) : 'Discovery not found';
  const desc = r ? discoveryDescription(r) : '';
  const score = r?.bestCandidate.score;
  const seq = r?.bestCandidate.sequence ?? '';
  const seqPreview = seq.length > 64 ? `${seq.slice(0, 64)}…` : seq;
  const hue = score === undefined ? 190 : Math.round(Math.max(0, Math.min(1, score)) * 120);
  const accent = `hsl(${hue}, 80%, 60%)`;

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: 64,
          background: 'linear-gradient(135deg, #0a0e1a 0%, #141e30 100%)',
          color: '#fff',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ fontSize: 22, letterSpacing: 6, color: '#7fd8ff', opacity: 0.85 }}>
              ETICAHUB LABS · DISCOVERY
            </div>
            {r?.disease && (
              <div
                style={{
                  fontSize: 20,
                  textTransform: 'uppercase',
                  letterSpacing: 3,
                  color: 'rgba(255,255,255,0.65)',
                }}
              >
                {r.disease}
              </div>
            )}
          </div>
          {score !== undefined && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
              <div style={{ fontSize: 72, fontWeight: 700, color: accent, lineHeight: 1 }}>
                {score.toFixed(2)}
              </div>
              <div style={{ fontSize: 18, letterSpacing: 3, color: '#7fd8ff' }}>
                {scoreLabel(score).toUpperCase()} CANDIDATE
              </div>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ fontSize: 52, fontWeight: 700, lineHeight: 1.15 }}>{title}</div>
          {desc && (
            <div style={{ fontSize: 24, color: 'rgba(205,214,244,0.85)', lineHeight: 1.35 }}>
              {desc}
            </div>
          )}
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            borderTop: '1px solid rgba(127,216,255,0.25)',
            paddingTop: 20,
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 16, letterSpacing: 3, color: '#7fd8ff' }}>
              SEQUENCE ({seq.length} aa)
            </div>
            <div style={{ fontSize: 20, fontFamily: 'monospace', color: 'rgba(255,255,255,0.9)' }}>
              {seqPreview}
            </div>
          </div>
          <div style={{ fontSize: 20, color: '#7fd8ff', opacity: 0.7 }}>eticahub.com/labs</div>
        </div>
      </div>
    ),
    size,
  );
}
