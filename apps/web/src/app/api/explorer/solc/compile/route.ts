import { NextResponse } from 'next/server';
import solc from 'solc';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const source = typeof body.source === 'string' ? body.source : '';
    const optimizer = Boolean(body.optimizer);
    const optimizerRuns = Number(body.optimizerRuns || 200);

    if (!source.trim()) {
      return NextResponse.json({ ok: false, error: 'Missing Solidity source' }, { status: 400 });
    }

    const input = {
      language: 'Solidity',
      sources: {
        'Contract.sol': {
          content: source,
        },
      },
      settings: {
        optimizer: {
          enabled: optimizer,
          runs: optimizerRuns,
        },
        outputSelection: {
          '*': {
            '*': ['abi', 'evm.bytecode.object'],
          },
        },
      },
    };

    const output = JSON.parse(solc.compile(JSON.stringify(input)));

    if (output.errors?.length) {
      const fatal = output.errors.find((e: any) => e.severity === 'error');
      if (fatal) {
        return NextResponse.json({ ok: false, error: fatal.formattedMessage || fatal.message }, { status: 400 });
      }
    }

    const compiled = output.contracts?.['Contract.sol'];
    if (!compiled) {
      return NextResponse.json({ ok: false, error: 'No contracts compiled' }, { status: 400 });
    }

    const contracts = Object.entries(compiled).map(([name, artifact]: [string, any]) => ({
      name,
      abi: artifact.abi,
      bytecode: `0x${artifact.evm.bytecode.object}`,
    }));

    return NextResponse.json({
      ok: true,
      contracts,
      compilerVersion: solc.version(),
      stdJsonInput: input,
      warnings: output.errors?.filter((e: any) => e.severity !== 'error') ?? [],
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Compilation failed',
    }, { status: 500 });
  }
}
