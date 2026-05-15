import { NextResponse } from 'next/server';
import { isAddress } from 'viem';

export const dynamic = 'force-dynamic';

const DEFAULT_CHAIN_ID = 61803;
const SOURCIFY_SERVER = (process.env.SOURCIFY_SERVER_URL || 'https://sourcify.dev/server').replace(/\/$/, '');

function error(message: string, status = 400, details?: unknown) {
  return NextResponse.json({ ok: false, error: message, details }, { status });
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return error('Request body must be JSON');
  }

  const address = typeof body.address === 'string' ? body.address.trim() : '';
  const chainId = Number(body.chainId || DEFAULT_CHAIN_ID);
  const compilerVersion = typeof body.compilerVersion === 'string' ? body.compilerVersion.trim() : '';
  const contractIdentifier = typeof body.contractIdentifier === 'string' ? body.contractIdentifier.trim() : '';
  const creationTransactionHash = typeof body.creationTransactionHash === 'string' ? body.creationTransactionHash.trim() : '';
  const stdJsonInput = body.stdJsonInput;

  if (!isAddress(address, { strict: false })) return error('Invalid contract address');
  if (!Number.isInteger(chainId) || chainId <= 0) return error('Invalid chain ID');
  if (!compilerVersion) return error('Compiler version is required');
  if (!contractIdentifier) return error('Contract identifier is required');
  if (!stdJsonInput || typeof stdJsonInput !== 'object') return error('Standard JSON compiler input is required');
  if (creationTransactionHash && !/^0x[a-fA-F0-9]{64}$/.test(creationTransactionHash)) {
    return error('Creation transaction hash must be a 32-byte hash');
  }

  const payload: Record<string, unknown> = {
    stdJsonInput,
    compilerVersion,
    contractIdentifier,
  };
  if (creationTransactionHash) payload.creationTransactionHash = creationTransactionHash;

  const response = await fetch(`${SOURCIFY_SERVER}/v2/verify/${chainId}/${address}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    cache: 'no-store',
  });

  const result = await response.json().catch(() => null);
  if (!response.ok) {
    return NextResponse.json({ ok: false, error: 'Sourcify verification failed', status: response.status, result }, { status: response.status });
  }

  return NextResponse.json({ ok: true, result });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const verificationId = searchParams.get('verificationId');
  if (!verificationId) return error('Missing verificationId');

  const response = await fetch(`${SOURCIFY_SERVER}/v2/verify/${encodeURIComponent(verificationId)}`, { cache: 'no-store' });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    return NextResponse.json({ ok: false, error: 'Unable to load verification status', status: response.status, result }, { status: response.status });
  }
  return NextResponse.json({ ok: true, result });
}
