import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const source = typeof body.source === 'string' ? body.source : '';

    if (!source.trim()) {
      return NextResponse.json({ ok: false, error: 'Missing Solidity source' }, { status: 400 });
    }

    return NextResponse.json(
      {
        ok: false,
        error:
          'Compiler service is not bundled in this preview build yet. Use Advanced mode with compiled bytecode/ABI while the hosted compiler backend is being enabled.',
      },
      { status: 501 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Compilation failed',
      },
      { status: 500 },
    );
  }
}
