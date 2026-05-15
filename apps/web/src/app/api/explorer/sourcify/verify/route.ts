import { NextResponse } from 'next/server';
import { isAddress } from 'viem';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const DEFAULT_CHAIN_ID = 61803;
const DEFAULT_SOURCIFY_SERVER = 'https://sourcify.dev/server';

const VerifyBody = z.object({
  address: z.string().refine((value) => isAddress(value, { strict: false }), {
    message: 'Address must be a valid EVM address',
  }),
  chainId: z.coerce.number().int().positive().default(DEFAULT_CHAIN_ID),
  compilerVersion: z.string().min(1, 'Compiler version is required'),
  contractIdentifier: z.string().min(1, 'Contract identifier is required'),
  stdJsonInput: z.unknown(),
  creationTransactionHash: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/, 'Creation transaction hash must be a 32-byte hash')
    .optional()
    .or(z.literal('')),
});

function sourcifyServer(): string {
  return (process.env.SOURCIFY_SERVER_URL || DEFAULT_SOURCIFY_SERVER).replace(/\/$/, '');
}

function jsonError(message: string, status = 400, details?: unknown) {
  return NextResponse.json({ ok: false, error: message, details }, { status });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError('Request body must be JSON');
  }

  const parsed = VerifyBody.safeParse(body);
  if (!parsed.success) {
    return jsonError('Invalid verification request', 400, parsed.error.flatten());
  }

  const {
    address,
    chainId,
    compilerVersion,
    contractIdentifier,
    stdJsonInput,
    creationTransactionHash,
  } = parsed.data;

  const payload: Record<string, unknown> = {
    stdJsonInput,
    compilerVersion,
    contractIdentifier,
  };
  if (creationTransactionHash) {
    payload.creationTransactionHash = creationTransactionHash;
  }

  const endpoint = `${sourcifyServer()}/v2/verify/${chainId}/${address}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    cache: 'no-store',
  });

  const result = await response.json().catch(() => null);
  if (!response.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Sourcify rejected the verification request',
        status: response.status,
        result,
      },
      { status: response.status },
    );
  }

  return NextResponse.json({ ok: true, result });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const verificationId = searchParams.get('verificationId');
  if (!verificationId) {
    return jsonError('Missing verificationId query parameter');
  }

  const endpoint = `${sourcifyServer()}/v2/verify/${encodeURIComponent(verificationId)}`;
  const response = await fetch(endpoint, { cache: 'no-store' });
  const result = await response.json().catch(() => null);

  if (!response.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Unable to load Sourcify verification status',
        status: response.status,
        result,
      },
      { status: response.status },
    );
  }

  return NextResponse.json({ ok: true, result });
}
