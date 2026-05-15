import { NextResponse } from 'next/server';
import solc from 'solc';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const source = typeof body.source === 'string' ? body.source : '';
    const contractName = typeof body.contractName === 'string' ? body.contractName : 'Contract';
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

    const contracts = output.contracts?.['Contract.sol'];
    if (!contracts) {
      return NextResponse.json({ ok: false, error: 'No contracts compiled' }, { status: 400 });
    }

    const selected = contracts[contractName] || Object.values(contracts)[0];
    if (!selected) {
      return NextResponse.json({ ok: false, error: 'Unable to select compiled contract' }, { status: 400 });
    }

    return NextResponse.json({
      ok: true,
      abi: selected.abi,
      bytecode: `0x${selected.evm.bytecode.object}`,
      compilerVersion: solc.version(),
      stdJsonInput: input,
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Compilation failed',
    }, { status: 500 });
  }
}
