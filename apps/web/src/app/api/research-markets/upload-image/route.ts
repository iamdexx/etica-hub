/**
 * POST /api/research-markets/upload-image
 *
 * Browser-side image upload for research-token launches. Accepts a
 * multipart/form-data request with a single `file` field and forwards
 * the binary to Pinata's pinFileToIPFS endpoint using a server-only
 * `PINATA_JWT` env var, then returns the resulting `ipfs://<CID>` URI.
 *
 * If `PINATA_JWT` is not set on the server, the route returns HTTP 503 so
 * the UI can fall back to letting the launcher paste an IPFS URI manually.
 *
 * Limits (anti-abuse, since this route is unauthenticated):
 *   - Max 2 MB per upload
 *   - PNG/JPEG/WebP/GIF only
 *
 * No user data is stored server-side; the route is a thin proxy so the
 * Pinata JWT never reaches the browser.
 */
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

const MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const PINATA_ENDPOINT = 'https://api.pinata.cloud/pinning/pinFileToIPFS';

export async function POST(req: NextRequest) {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) {
    return NextResponse.json(
      {
        error:
          'Image upload is disabled on this deployment. Paste an IPFS URI manually (ipfs://… or https://…) in the launch form.',
      },
      { status: 503 },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Invalid multipart payload.' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Missing `file` field.' }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: 'Empty file.' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `Image too large (${file.size} bytes). Max 2 MB.` },
      { status: 413 },
    );
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    return NextResponse.json(
      { error: `Unsupported file type "${file.type}". Use PNG, JPEG, WebP, or GIF.` },
      { status: 415 },
    );
  }

  const upstream = new FormData();
  upstream.append('file', file, file.name || 'token-image');
  upstream.append(
    'pinataMetadata',
    JSON.stringify({ name: `research-markets-${Date.now()}-${file.name || 'image'}` }),
  );

  let resp: Response;
  try {
    resp = await fetch(PINATA_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}` },
      body: upstream,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json(
      { error: `Pinata request failed: ${message}` },
      { status: 502 },
    );
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    return NextResponse.json(
      { error: `Pinata upload failed (${resp.status}): ${detail.slice(0, 200)}` },
      { status: 502 },
    );
  }

  const json = (await resp.json().catch(() => null)) as { IpfsHash?: string } | null;
  const cid = json?.IpfsHash;
  if (!cid) {
    return NextResponse.json({ error: 'Pinata returned no CID.' }, { status: 502 });
  }

  return NextResponse.json({
    uri: `ipfs://${cid}`,
    cid,
    gatewayUrl: `https://ipfs.io/ipfs/${cid}`,
  });
}
