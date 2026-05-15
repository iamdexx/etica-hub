'use client';

import { useMemo, useState } from 'react';
import { useAccount, useDeployContract, useWaitForTransactionReceipt } from 'wagmi';
import { isAddress, type Abi, type AbiParameter, type Hex } from 'viem';
import Link from 'next/link';

type DeployMode = 'compiler' | 'advanced';

type ConstructorAbiItem = {
  type: 'constructor';
  inputs?: readonly AbiParameter[];
};

type CompiledContract = {
  name: string;
  abi: Abi;
  bytecode: Hex;
};

type CompileResult = {
  contracts: CompiledContract[];
  compilerVersion: string;
  stdJsonInput: unknown;
};

const DEFAULT_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MyEticaContract {
    string public name;

    constructor(string memory _name) {
        name = _name;
    }
}`;

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

function constructorInputs(abi: Abi | null): readonly AbiParameter[] {
  const ctor = abi?.find((item) => item.type === 'constructor') as ConstructorAbiItem | undefined;
  return ctor?.inputs ?? [];
}

export function ContractDeployForm() {
  const { isConnected } = useAccount();
  const [mode, setMode] = useState<DeployMode>('compiler');

  const [source, setSource] = useState(DEFAULT_SOURCE);
  const [selectedContract, setSelectedContract] = useState('');
  const [optimizer, setOptimizer] = useState(true);
  const [optimizerRuns, setOptimizerRuns] = useState('200');
  const [license, setLicense] = useState('MIT');
  const [compiled, setCompiled] = useState<CompileResult | null>(null);
  const [compileError, setCompileError] = useState<string | null>(null);
  const [isCompiling, setIsCompiling] = useState(false);
  const [constructorValues, setConstructorValues] = useState<string[]>(['My Etica Contract']);

  const [bytecode, setBytecode] = useState('');
  const [abiInput, setAbiInput] = useState('[]');
  const [argsInput, setArgsInput] = useState('["My Etica Contract"]');
  const [valueInput, setValueInput] = useState('');
  const [deployedAddress, setDeployedAddress] = useState<string | null>(null);

  const { deployContract, data: hash, error, isPending } = useDeployContract();
  const { data: receipt, isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  const abi = useMemo(() => parseJsonAbi(abiInput), [abiInput]);
  const advancedArgs = useMemo(() => parseConstructorArgs(argsInput), [argsInput]);
  const normalizedBytecode = useMemo(() => normalizeBytecode(bytecode), [bytecode]);

  const activeContract = useMemo(() => {
    if (!compiled) return null;
    return compiled.contracts.find((contract) => contract.name === selectedContract) ?? compiled.contracts[0] ?? null;
  }, [compiled, selectedContract]);

  const activeAbi = mode === 'compiler' ? activeContract?.abi ?? null : abi;
  const activeBytecode = mode === 'compiler' ? activeContract?.bytecode ?? null : normalizedBytecode;
  const ctorInputs = useMemo(() => constructorInputs(activeAbi), [activeAbi]);
  const compilerArgs = useMemo(() => constructorValues.slice(0, ctorInputs.length), [constructorValues, ctorInputs.length]);
  const activeArgs = mode === 'compiler' ? compilerArgs : advancedArgs;
  const canDeploy = isConnected && activeBytecode && activeAbi && activeArgs && !isPending && !isConfirming;

  const verifyHref = useMemo(() => {
    if (!deployedAddress) return '/explorer/verify';
    const params = new URLSearchParams({ address: deployedAddress });
    if (compiled?.compilerVersion) params.set('compilerVersion', compiled.compilerVersion);
    if (activeContract?.name) params.set('contractIdentifier', `Contract.sol:${activeContract.name}`);
    if (license) params.set('license', license);
    return `/explorer/verify?${params.toString()}`;
  }, [activeContract?.name, compiled?.compilerVersion, deployedAddress, license]);

  function selectCompiledContract(name: string) {
    setSelectedContract(name);
    const contract = compiled?.contracts.find((item) => item.name === name) ?? null;
    setConstructorValues(constructorInputs(contract?.abi ?? null).map(() => ''));
  }

  async function onCompile() {
    setIsCompiling(true);
    setCompileError(null);
    setCompiled(null);
    try {
      const response = await fetch('/api/explorer/solc/compile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source,
          optimizer,
          optimizerRuns: Number(optimizerRuns || 200),
        }),
      });
      const json = await response.json();
      if (!response.ok || !json.ok) throw new Error(json.error || 'Compilation failed');
      const contracts = json.contracts as CompiledContract[];
      const first = contracts[0];
      setCompiled({ contracts, compilerVersion: json.compilerVersion, stdJsonInput: json.stdJsonInput });
      setSelectedContract(first?.name ?? '');
      setConstructorValues(constructorInputs(first?.abi ?? null).map(() => ''));
    } catch (err) {
      setCompileError(err instanceof Error ? err.message : 'Compilation failed');
    } finally {
      setIsCompiling(false);
    }
  }

  function onDeploy() {
    if (!activeBytecode || !activeAbi || !activeArgs) return;
    setDeployedAddress(null);
    deployContract({
      abi: activeAbi,
      bytecode: activeBytecode,
      args: activeArgs,
      value: valueInput.trim() ? BigInt(valueInput.trim()) : undefined,
    });
  }

  useMemo(() => {
    const created = receipt?.contractAddress;
    if (created && isAddress(created)) setDeployedAddress(created);
  }, [receipt]);

  return (
    <div className="space-y-5 rounded-xl border border-white/10 bg-[#07120f] p-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-emerald-300/70">EticaHub Scan</div>
          <h2 className="mt-1 text-xl font-semibold">Deploy Contract</h2>
          <p className="mt-1 max-w-3xl text-sm text-white/60">
            Compile Solidity source, select the compiled contract, deploy from your wallet, then verify through Sourcify. Raw bytecode deployment remains under Advanced.
          </p>
        </div>
        <div className="flex rounded-lg border border-white/10 bg-black/30 p-1 text-xs">
          <button type="button" onClick={() => setMode('compiler')} className={`rounded-md px-3 py-2 ${mode === 'compiler' ? 'bg-brand-accent text-brand-ink' : 'text-white/65 hover:text-white'}`}>Compiler</button>
          <button type="button" onClick={() => setMode('advanced')} className={`rounded-md px-3 py-2 ${mode === 'advanced' ? 'bg-brand-accent text-brand-ink' : 'text-white/65 hover:text-white'}`}>Advanced</button>
        </div>
      </div>

      {mode === 'compiler' ? (
        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-[1fr_0.6fr_0.4fr]">
            <label className="block space-y-2">
              <span className="text-xs uppercase tracking-wider text-white/50">Compiled Contract</span>
              <select value={selectedContract} onChange={(e) => selectCompiledContract(e.target.value)} disabled={!compiled?.contracts.length} className="w-full rounded-lg border border-white/10 bg-black/30 p-3 text-xs text-white focus:border-brand-accent focus:outline-none">
                {compiled?.contracts.length ? compiled.contracts.map((contract) => <option key={contract.name} value={contract.name}>{contract.name}</option>) : <option>Compile source first</option>}
              </select>
            </label>
            <label className="block space-y-2">
              <span className="text-xs uppercase tracking-wider text-white/50">Optimizer</span>
              <select value={optimizer ? 'on' : 'off'} onChange={(e) => setOptimizer(e.target.value === 'on')} className="w-full rounded-lg border border-white/10 bg-black/30 p-3 text-xs text-white focus:border-brand-accent focus:outline-none">
                <option value="on">Enabled</option><option value="off">Disabled</option>
              </select>
            </label>
            <label className="block space-y-2">
              <span className="text-xs uppercase tracking-wider text-white/50">Runs</span>
              <input value={optimizerRuns} onChange={(e) => setOptimizerRuns(e.target.value.replace(/[^0-9]/g, ''))} className="w-full rounded-lg border border-white/10 bg-black/30 p-3 font-mono text-xs text-white focus:border-brand-accent focus:outline-none" />
            </label>
          </div>

          <label className="block space-y-2">
            <span className="text-xs uppercase tracking-wider text-white/50">License</span>
            <select value={license} onChange={(e) => setLicense(e.target.value)} className="w-full rounded-lg border border-white/10 bg-black/30 p-3 text-xs text-white focus:border-brand-accent focus:outline-none">
              <option value="MIT">MIT</option>
              <option value="GPL-3.0">GPL-3.0</option>
              <option value="LGPL-3.0">LGPL-3.0</option>
              <option value="Apache-2.0">Apache-2.0</option>
              <option value="BSD-3-Clause">BSD-3-Clause</option>
              <option value="UNLICENSED">UNLICENSED</option>
            </select>
          </label>

          <label className="block space-y-2">
            <span className="text-xs uppercase tracking-wider text-white/50">Solidity Source</span>
            <textarea value={source} onChange={(e) => setSource(e.target.value)} className="min-h-[24rem] w-full rounded-lg border border-white/10 bg-black/30 p-3 font-mono text-xs leading-relaxed text-white placeholder-white/30 focus:border-brand-accent focus:outline-none" />
          </label>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-black/20 p-3">
            <div className="text-xs text-white/50">Compiles Solidity and returns all contracts in the source file for selection.</div>
            <button type="button" onClick={onCompile} disabled={isCompiling} className="rounded-md bg-brand-accent px-4 py-2 text-xs font-semibold text-brand-ink hover:opacity-90 disabled:opacity-50">{isCompiling ? 'Compiling...' : 'Compile'}</button>
          </div>

          {compileError ? <p className="rounded-lg border border-red-400/30 bg-red-400/10 p-3 text-xs text-red-200">{compileError}</p> : null}
          {compiled ? <div className="rounded-lg border border-emerald-400/30 bg-emerald-400/10 p-3 text-xs text-emerald-100">Compiled {compiled.contracts.length} contract(s) with solc {compiled.compilerVersion}.</div> : null}

          {ctorInputs.length > 0 ? (
            <div className="space-y-3 rounded-lg border border-white/10 bg-black/20 p-4">
              <div className="text-xs uppercase tracking-wider text-white/50">Constructor Arguments</div>
              {ctorInputs.map((input, index) => (
                <label key={`${input.name}-${index}`} className="block space-y-2">
                  <span className="text-xs text-white/50">{input.name || `arg${index}`} <span className="font-mono text-white/35">{input.type}</span></span>
                  <input value={constructorValues[index] ?? ''} onChange={(e) => setConstructorValues((values) => values.map((value, i) => i === index ? e.target.value : value))} className="w-full rounded-lg border border-white/10 bg-black/30 p-3 font-mono text-xs text-white focus:border-brand-accent focus:outline-none" />
                </label>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="space-y-4 rounded-lg border border-white/10 bg-black/20 p-4">
          <label className="block space-y-2"><span className="text-xs uppercase tracking-wider text-white/50">Bytecode</span><textarea value={bytecode} onChange={(e) => setBytecode(e.target.value)} placeholder="0x6080604052..." className="min-h-36 w-full rounded-xl border border-white/10 bg-black/30 p-3 font-mono text-xs text-white placeholder-white/30 focus:border-brand-accent focus:outline-none" />{bytecode && !normalizedBytecode ? <span className="text-xs text-red-300">Bytecode must be 0x-prefixed hex.</span> : null}</label>
          <label className="block space-y-2"><span className="text-xs uppercase tracking-wider text-white/50">ABI JSON</span><textarea value={abiInput} onChange={(e) => setAbiInput(e.target.value)} className="min-h-28 w-full rounded-xl border border-white/10 bg-black/30 p-3 font-mono text-xs text-white placeholder-white/30 focus:border-brand-accent focus:outline-none" />{abiInput && !abi ? <span className="text-xs text-red-300">ABI must be a JSON array.</span> : null}</label>
        </div>
      )}

      {mode === 'advanced' ? <label className="block space-y-2"><span className="text-xs uppercase tracking-wider text-white/50">Constructor args JSON array</span><input value={argsInput} onChange={(e) => setArgsInput(e.target.value)} placeholder='["arg1", 123, "0x..."]' className="w-full rounded-xl border border-white/10 bg-black/30 p-3 font-mono text-xs text-white placeholder-white/30 focus:border-brand-accent focus:outline-none" />{argsInput && !advancedArgs ? <span className="text-xs text-red-300">Constructor args must be a JSON array.</span> : null}</label> : null}

      <label className="block space-y-2"><span className="text-xs uppercase tracking-wider text-white/50">Optional native value in wei</span><input value={valueInput} onChange={(e) => setValueInput(e.target.value.replace(/[^0-9]/g, ''))} placeholder="0" className="w-full rounded-xl border border-white/10 bg-black/30 p-3 font-mono text-xs text-white placeholder-white/30 focus:border-brand-accent focus:outline-none" /></label>
      {!isConnected ? <p className="rounded-xl border border-yellow-400/20 bg-yellow-400/10 p-3 text-sm text-yellow-200">Connect your wallet from the header to deploy contracts.</p> : null}
      <button onClick={onDeploy} disabled={!canDeploy} className="w-full rounded-xl bg-brand-accent px-5 py-3 text-sm font-semibold text-brand-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">{isPending ? 'Confirm in wallet...' : isConfirming ? 'Deploying...' : mode === 'compiler' && !compiled ? 'Compile before deploy' : 'Deploy contract'}</button>
      {hash ? <Result label="Transaction" href={`/explorer/tx/${hash}`} value={hash} /> : null}
      {isSuccess && deployedAddress ? <div className="rounded-xl border border-emerald-400/30 bg-emerald-400/10 p-3 text-sm text-emerald-100">Contract deployed: <Link href={`/explorer/address/${deployedAddress}`} className="break-all font-mono text-brand-accent hover:underline">{deployedAddress}</Link><div className="mt-2"><Link href={verifyHref} className="text-xs text-brand-accent hover:underline">Verify this contract →</Link></div></div> : null}
      {error ? <p className="rounded-xl border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-200">{error.message.slice(0, 500)}</p> : null}
    </div>
  );
}

function Result({ label, href, value }: { label: string; href: string; value: string }) {
  return <div className="rounded-xl border border-white/10 bg-black/30 p-3 text-sm"><div className="text-white/50">{label}</div><Link href={href} className="break-all font-mono text-brand-accent hover:underline">{value}</Link></div>;
}