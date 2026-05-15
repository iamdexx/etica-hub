'use client';

import { useMemo, useState } from 'react';
import { useAccount, useDeployContract, useWaitForTransactionReceipt } from 'wagmi';
import { isAddress, type Abi, type Hex } from 'viem';
import Link from 'next/link';

function parseJsonAbi(value: string): Abi | null {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as Abi) : null;
  } catch {
    return null;
  }
}

function parseConstructorArgs(value: string): readonly unknown[] | null {
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeBytecode(value: string): Hex | null {
  const trimmed = value.trim();
  if (!/^0x[0-9a-fA-F]*$/.test(trimmed)) return null;
  return trimmed as Hex;
}

export function ContractDeployForm() {
  const { isConnected } = useAccount();
  const [bytecode, setBytecode] = useState('');
  const [abiInput, setAbiInput] = useState('[]');
  const [argsInput, setArgsInput] = useState('[]');
  const [valueInput, setValueInput] = useState('');
  const [deployedAddress, setDeployedAddress] = useState<string | null>(null);
  const { deployContract, data: hash, error, isPending } = useDeployContract();
  const { data: receipt, isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  const abi = useMemo(() => parseJsonAbi(abiInput), [abiInput]);
  const args = useMemo(() => parseConstructorArgs(argsInput), [argsInput]);
  const normalizedBytecode = useMemo(() => normalizeBytecode(bytecode), [bytecode]);

  const canDeploy = isConnected && normalizedBytecode && abi && args && !isPending && !isConfirming;

  function onDeploy() {
    if (!normalizedBytecode || !abi || !args) return;
    setDeployedAddress(null);
    deployContract({
      abi,
      bytecode: normalizedBytecode,
      args,
      value: valueInput.trim() ? BigInt(valueInput.trim()) : undefined,
    });
  }

  useMemo(() => {
    const created = receipt?.contractAddress;
    if (created && isAddress(created)) setDeployedAddress(created);
  }, [receipt]);

  return (
    <div className="space-y-5 rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div>
        <h2 className="text-xl font-semibold">Deploy contract</h2>
        <p className="mt-1 text-sm text-white/60">
          Paste compiled bytecode, ABI, and constructor args. EticaHub sends the deployment transaction from your connected wallet and links directly to the new contract address.
        </p>
      </div>

      <label className="block space-y-2">
        <span className="text-xs uppercase tracking-wider text-white/50">Bytecode</span>
        <textarea
          value={bytecode}
          onChange={(e) => setBytecode(e.target.value)}
          placeholder="0x6080604052..."
          className="min-h-36 w-full rounded-xl border border-white/10 bg-black/30 p-3 font-mono text-xs text-white placeholder-white/30 focus:border-brand-accent focus:outline-none"
        />
        {bytecode && !normalizedBytecode ? <span className="text-xs text-red-300">Bytecode must be 0x-prefixed hex.</span> : null}
      </label>

      <label className="block space-y-2">
        <span className="text-xs uppercase tracking-wider text-white/50">ABI JSON</span>
        <textarea
          value={abiInput}
          onChange={(e) => setAbiInput(e.target.value)}
          className="min-h-28 w-full rounded-xl border border-white/10 bg-black/30 p-3 font-mono text-xs text-white placeholder-white/30 focus:border-brand-accent focus:outline-none"
        />
        {abiInput && !abi ? <span className="text-xs text-red-300">ABI must be a JSON array.</span> : null}
      </label>

      <label className="block space-y-2">
        <span className="text-xs uppercase tracking-wider text-white/50">Constructor args JSON array</span>
        <input
          value={argsInput}
          onChange={(e) => setArgsInput(e.target.value)}
          placeholder='["arg1", 123, "0x..."]'
          className="w-full rounded-xl border border-white/10 bg-black/30 p-3 font-mono text-xs text-white placeholder-white/30 focus:border-brand-accent focus:outline-none"
        />
        {argsInput && !args ? <span className="text-xs text-red-300">Constructor args must be a JSON array.</span> : null}
      </label>

      <label className="block space-y-2">
        <span className="text-xs uppercase tracking-wider text-white/50">Optional native value in wei</span>
        <input
          value={valueInput}
          onChange={(e) => setValueInput(e.target.value.replace(/[^0-9]/g, ''))}
          placeholder="0"
          className="w-full rounded-xl border border-white/10 bg-black/30 p-3 font-mono text-xs text-white placeholder-white/30 focus:border-brand-accent focus:outline-none"
        />
      </label>

      {!isConnected ? (
        <p className="rounded-xl border border-yellow-400/20 bg-yellow-400/10 p-3 text-sm text-yellow-200">
          Connect your wallet from the header to deploy contracts.
        </p>
      ) : null}

      <button
        onClick={onDeploy}
        disabled={!canDeploy}
        className="w-full rounded-xl bg-brand-accent px-5 py-3 text-sm font-semibold text-brand-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending ? 'Confirm in wallet…' : isConfirming ? 'Deploying…' : 'Deploy contract'}
      </button>

      {hash ? (
        <div className="rounded-xl border border-white/10 bg-black/30 p-3 text-sm">
          <div className="text-white/50">Transaction</div>
          <Link href={`/explorer/tx/${hash}`} className="break-all font-mono text-brand-accent hover:underline">
            {hash}
          </Link>
        </div>
      ) : null}

      {isSuccess && deployedAddress ? (
        <div className="rounded-xl border border-emerald-400/30 bg-emerald-400/10 p-3 text-sm text-emerald-100">
          Contract deployed:{' '}
          <Link href={`/explorer/address/${deployedAddress}`} className="break-all font-mono text-brand-accent hover:underline">
            {deployedAddress}
          </Link>
        </div>
      ) : null}

      {error ? (
        <p className="rounded-xl border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-200">
          {error.message.slice(0, 500)}
        </p>
      ) : null}
    </div>
  );
}
