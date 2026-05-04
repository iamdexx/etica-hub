'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BaseError,
  UserRejectedRequestError,
  encodeDeployData,
  formatUnits,
  getAddress,
  parseUnits,
  type Address,
  type Hex,
} from 'viem';
import {
  useAccount,
  useChainId,
  useConnect,
  useDisconnect,
  usePublicClient,
  useSwitchChain,
  useWalletClient,
} from 'wagmi';
import { abis, DEPLOYMENTS, TREASURY_ADDRESS } from '@etica-hub/shared';
import { eticaMainnet } from '@etica-hub/shared/chains';
import poolArtifact from '@/lib/etica-stableswap-artifact.json';
import timelockArtifact from '@/lib/liquidity-timelock-10y-artifact.json';
import adapterArtifact from '@/lib/stableswap-harvester-adapter-artifact.json';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
const MAX_UINT256 = (1n << 256n) - 1n;

type TxState = {
  status: 'idle' | 'signing' | 'pending' | 'confirmed' | 'error';
  txHash?: Hex;
  address?: Address;
  error?: string;
};

const initial: TxState = { status: 'idle' };

function shortError(err: unknown): string {
  if (err instanceof UserRejectedRequestError) return 'Rejected in wallet.';
  if (err instanceof BaseError) return err.shortMessage ?? err.message;
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

function StateBadge({ state, label }: { state: TxState; label: string }) {
  if (state.status === 'idle') return null;
  if (state.status === 'error') {
    return (
      <p className="mt-2 rounded-md border border-rose-400/30 bg-rose-500/10 p-2 text-xs text-rose-200">
        {label}: {state.error}
      </p>
    );
  }
  return (
    <p className="mt-2 text-xs text-white/60">
      {label}:{' '}
      {state.status === 'signing'
        ? 'sign in wallet…'
        : state.status === 'pending'
          ? 'waiting for confirmation…'
          : state.status === 'confirmed'
            ? state.address
              ? `deployed at ${state.address}`
              : 'confirmed'
            : ''}
      {state.txHash && (
        <>
          {' · tx '}
          <a
            href={`https://eticascan.org/tx/${state.txHash}`}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-emerald-400 hover:underline"
          >
            {state.txHash.slice(0, 10)}…
          </a>
        </>
      )}
    </p>
  );
}

const SEED_AMOUNT_HUMAN = '15000000';

export function DeployStableSwapCard() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { connectors, connect, status: connectStatus } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();

  const onMainnet = chainId === eticaMainnet.id;
  const D = DEPLOYMENTS[eticaMainnet.id];
  const defaultEtx = D.etx;
  const defaultStEtx = D.stakedETX;
  const defaultStakedSink = D.stakedETX;
  const defaultFarmsSink = D.etxFarms;
  const defaultOwner = TREASURY_ADDRESS;

  // Constructor inputs
  const [ownerInput, setOwnerInput] = useState<string>(defaultOwner);
  const [etxInput, setEtxInput] = useState<string>(defaultEtx);
  const [stEtxInput, setStEtxInput] = useState<string>(defaultStEtx);
  const [aInput, setAInput] = useState<string>('200');
  const [stakedSinkInput, setStakedSinkInput] = useState<string>(defaultStakedSink);
  const [farmsSinkInput, setFarmsSinkInput] = useState<string>(defaultFarmsSink);
  const [treasuryInput, setTreasuryInput] = useState<string>(defaultOwner);
  const [seedAmountHuman, setSeedAmountHuman] = useState<string>(SEED_AMOUNT_HUMAN);

  const ownerEdited = useRef(false);
  const etxEdited = useRef(false);
  const stEtxEdited = useRef(false);
  const stakedSinkEdited = useRef(false);
  const farmsSinkEdited = useRef(false);
  const treasuryEdited = useRef(false);

  useEffect(() => {
    if (!ownerEdited.current) setOwnerInput(defaultOwner);
  }, [defaultOwner]);
  useEffect(() => {
    if (!etxEdited.current) setEtxInput(defaultEtx);
  }, [defaultEtx]);
  useEffect(() => {
    if (!stEtxEdited.current) setStEtxInput(defaultStEtx);
  }, [defaultStEtx]);
  useEffect(() => {
    if (!stakedSinkEdited.current) setStakedSinkInput(defaultStakedSink);
  }, [defaultStakedSink]);
  useEffect(() => {
    if (!farmsSinkEdited.current) setFarmsSinkInput(defaultFarmsSink);
  }, [defaultFarmsSink]);
  useEffect(() => {
    if (!treasuryEdited.current) setTreasuryInput(defaultOwner);
  }, [defaultOwner]);

  function parsedAddr(input: string): Address | null {
    try {
      const a = getAddress(input.trim());
      return a === ZERO_ADDRESS ? null : a;
    } catch {
      return null;
    }
  }

  const parsedOwner = useMemo(() => parsedAddr(ownerInput), [ownerInput]);
  const parsedEtx = useMemo(() => parsedAddr(etxInput), [etxInput]);
  const parsedStEtx = useMemo(() => parsedAddr(stEtxInput), [stEtxInput]);
  const parsedStakedSink = useMemo(() => parsedAddr(stakedSinkInput), [stakedSinkInput]);
  const parsedFarmsSink = useMemo(() => parsedAddr(farmsSinkInput), [farmsSinkInput]);
  const parsedTreasury = useMemo(() => parsedAddr(treasuryInput), [treasuryInput]);

  const aValue = useMemo(() => {
    const n = Number(aInput);
    return Number.isFinite(n) && n > 0 && n < 1_000_001 ? BigInt(Math.floor(n)) : null;
  }, [aInput]);

  const seedAmount = useMemo(() => {
    try {
      const v = parseUnits(seedAmountHuman.trim(), 18);
      return v > 0n ? v : null;
    } catch {
      return null;
    }
  }, [seedAmountHuman]);

  // Step state
  const [poolState, setPoolState] = useState<TxState>(initial);
  const [timelockState, setTimelockState] = useState<TxState>(initial);
  const [adapterState, setAdapterState] = useState<TxState>(initial);
  const [approveEtxState, setApproveEtxState] = useState<TxState>(initial);
  const [stakeState, setStakeState] = useState<TxState>(initial);
  const [approveStEtxState, setApproveStEtxState] = useState<TxState>(initial);
  const [seedState, setSeedState] = useState<TxState>(initial);
  const [setLockState, setSetLockState] = useState<TxState>(initial);
  const [setRecipientState, setSetRecipientState] = useState<TxState>(initial);

  const poolAddr = poolState.address;
  const timelockAddr = timelockState.address;
  const adapterAddr = adapterState.address;

  // Pool LP balance held by the treasury after seed (so the operator can
  // pin `setLockedAmount` exactly to the seed mint).
  const [pendingLpAtTreasury, setPendingLpAtTreasury] = useState<bigint | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!publicClient || !poolAddr || !parsedOwner) return;
      try {
        const bal = (await publicClient.readContract({
          address: poolAddr,
          abi: abis.eticaStableSwapAbi,
          functionName: 'balanceOf',
          args: [timelockAddr ?? parsedOwner],
        })) as bigint;
        if (!cancelled) setPendingLpAtTreasury(bal);
      } catch {
        if (!cancelled) setPendingLpAtTreasury(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, poolAddr, timelockAddr, parsedOwner, seedState.status]);

  // ─── Step 1: Deploy pool ──────────────────────────────────────────────
  async function deployPool() {
    if (!walletClient || !publicClient || !address) return;
    if (!parsedOwner || !parsedEtx || !parsedStEtx || !aValue) return;
    setPoolState({ status: 'signing' });
    try {
      const data = encodeDeployData({
        abi: poolArtifact.abi,
        bytecode: poolArtifact.bytecode as Hex,
        args: [parsedEtx, parsedStEtx, aValue, parsedOwner],
      });
      const hash = await walletClient.sendTransaction({ account: address, data });
      setPoolState({ status: 'pending', txHash: hash });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success' || !receipt.contractAddress) {
        setPoolState({ status: 'error', txHash: hash, error: 'Deploy reverted' });
        return;
      }
      setPoolState({
        status: 'confirmed',
        txHash: hash,
        address: receipt.contractAddress as Address,
      });
    } catch (err) {
      setPoolState({ status: 'error', error: shortError(err) });
    }
  }

  // ─── Step 2: Deploy timelock ─────────────────────────────────────────
  async function deployTimelock() {
    if (!walletClient || !publicClient || !address) return;
    if (!parsedOwner || !poolAddr) return;
    setTimelockState({ status: 'signing' });
    try {
      const data = encodeDeployData({
        abi: timelockArtifact.abi,
        bytecode: timelockArtifact.bytecode as Hex,
        args: [parsedOwner, poolAddr],
      });
      const hash = await walletClient.sendTransaction({ account: address, data });
      setTimelockState({ status: 'pending', txHash: hash });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success' || !receipt.contractAddress) {
        setTimelockState({ status: 'error', txHash: hash, error: 'Deploy reverted' });
        return;
      }
      setTimelockState({
        status: 'confirmed',
        txHash: hash,
        address: receipt.contractAddress as Address,
      });
    } catch (err) {
      setTimelockState({ status: 'error', error: shortError(err) });
    }
  }

  // ─── Step 3: Deploy adapter ──────────────────────────────────────────
  async function deployAdapter() {
    if (!walletClient || !publicClient || !address) return;
    if (
      !parsedOwner ||
      !poolAddr ||
      !parsedEtx ||
      !parsedStEtx ||
      !parsedStakedSink ||
      !parsedFarmsSink ||
      !parsedTreasury
    ) {
      return;
    }
    setAdapterState({ status: 'signing' });
    try {
      const data = encodeDeployData({
        abi: adapterArtifact.abi,
        bytecode: adapterArtifact.bytecode as Hex,
        args: [
          parsedOwner,
          poolAddr,
          parsedEtx,
          parsedStEtx,
          parsedStakedSink,
          parsedFarmsSink,
          parsedTreasury,
        ],
      });
      const hash = await walletClient.sendTransaction({ account: address, data });
      setAdapterState({ status: 'pending', txHash: hash });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success' || !receipt.contractAddress) {
        setAdapterState({ status: 'error', txHash: hash, error: 'Deploy reverted' });
        return;
      }
      setAdapterState({
        status: 'confirmed',
        txHash: hash,
        address: receipt.contractAddress as Address,
      });
    } catch (err) {
      setAdapterState({ status: 'error', error: shortError(err) });
    }
  }

  // ─── Step 4: Approve 30M ETX (deployer wallet → vault + pool) ─────────
  async function doApproveEtx() {
    if (!walletClient || !publicClient || !parsedEtx) return;
    setApproveEtxState({ status: 'signing' });
    try {
      const hash = await walletClient.writeContract({
        address: parsedEtx,
        abi: abis.erc20Abi,
        functionName: 'approve',
        args: [parsedStEtx ?? ZERO_ADDRESS, MAX_UINT256],
      });
      setApproveEtxState({ status: 'pending', txHash: hash });
      const r = await publicClient.waitForTransactionReceipt({ hash });
      if (r.status !== 'success') {
        setApproveEtxState({ status: 'error', txHash: hash, error: 'Reverted' });
        return;
      }
      setApproveEtxState({ status: 'confirmed', txHash: hash });
    } catch (err) {
      setApproveEtxState({ status: 'error', error: shortError(err) });
    }
  }

  // ─── Step 5: Deposit 15M ETX into stETX vault ─────────────────────────
  async function doStake() {
    if (!walletClient || !publicClient || !parsedStEtx || !address || !seedAmount) return;
    setStakeState({ status: 'signing' });
    try {
      const hash = await walletClient.writeContract({
        address: parsedStEtx,
        abi: abis.stakedEtxAbi,
        functionName: 'deposit',
        args: [seedAmount, address],
      });
      setStakeState({ status: 'pending', txHash: hash });
      const r = await publicClient.waitForTransactionReceipt({ hash });
      if (r.status !== 'success') {
        setStakeState({ status: 'error', txHash: hash, error: 'Reverted' });
        return;
      }
      setStakeState({ status: 'confirmed', txHash: hash });
    } catch (err) {
      setStakeState({ status: 'error', error: shortError(err) });
    }
  }

  // ─── Step 6: Approve ETX + stETX to pool ──────────────────────────────
  async function doApprovePool() {
    if (!walletClient || !publicClient || !parsedEtx || !parsedStEtx || !poolAddr) return;
    setApproveStEtxState({ status: 'signing' });
    try {
      const h1 = await walletClient.writeContract({
        address: parsedEtx,
        abi: abis.erc20Abi,
        functionName: 'approve',
        args: [poolAddr, MAX_UINT256],
      });
      setApproveStEtxState({ status: 'pending', txHash: h1 });
      const r1 = await publicClient.waitForTransactionReceipt({ hash: h1 });
      if (r1.status !== 'success') {
        setApproveStEtxState({ status: 'error', txHash: h1, error: 'ETX approve reverted' });
        return;
      }
      const h2 = await walletClient.writeContract({
        address: parsedStEtx,
        abi: abis.erc20Abi,
        functionName: 'approve',
        args: [poolAddr, MAX_UINT256],
      });
      setApproveStEtxState({ status: 'pending', txHash: h2 });
      const r2 = await publicClient.waitForTransactionReceipt({ hash: h2 });
      if (r2.status !== 'success') {
        setApproveStEtxState({ status: 'error', txHash: h2, error: 'stETX approve reverted' });
        return;
      }
      setApproveStEtxState({ status: 'confirmed', txHash: h2 });
    } catch (err) {
      setApproveStEtxState({ status: 'error', error: shortError(err) });
    }
  }

  // ─── Step 7: addLiquidity → timelock ──────────────────────────────────
  async function doSeed() {
    if (!walletClient || !publicClient || !poolAddr || !timelockAddr || !seedAmount) return;
    setSeedState({ status: 'signing' });
    try {
      const hash = await walletClient.writeContract({
        address: poolAddr,
        abi: abis.eticaStableSwapAbi,
        functionName: 'addLiquidity',
        args: [seedAmount, seedAmount, 0n, timelockAddr],
      });
      setSeedState({ status: 'pending', txHash: hash });
      const r = await publicClient.waitForTransactionReceipt({ hash });
      if (r.status !== 'success') {
        setSeedState({ status: 'error', txHash: hash, error: 'Reverted' });
        return;
      }
      setSeedState({ status: 'confirmed', txHash: hash });
    } catch (err) {
      setSeedState({ status: 'error', error: shortError(err) });
    }
  }

  // ─── Step 8: setLockedAmount on timelock (treasury only) ──────────────
  async function doSetLock() {
    if (!walletClient || !publicClient || !timelockAddr || !pendingLpAtTreasury) return;
    setSetLockState({ status: 'signing' });
    try {
      const hash = await walletClient.writeContract({
        address: timelockAddr,
        abi: abis.liquidityTimelock10yAbi,
        functionName: 'setLockedAmount',
        args: [pendingLpAtTreasury],
      });
      setSetLockState({ status: 'pending', txHash: hash });
      const r = await publicClient.waitForTransactionReceipt({ hash });
      if (r.status !== 'success') {
        setSetLockState({ status: 'error', txHash: hash, error: 'Reverted' });
        return;
      }
      setSetLockState({ status: 'confirmed', txHash: hash });
    } catch (err) {
      setSetLockState({ status: 'error', error: shortError(err) });
    }
  }

  // ─── Step 9: pool.setAdminFeeRecipient(adapter) (treasury only) ───────
  async function doSetRecipient() {
    if (!walletClient || !publicClient || !poolAddr || !adapterAddr) return;
    setSetRecipientState({ status: 'signing' });
    try {
      const hash = await walletClient.writeContract({
        address: poolAddr,
        abi: abis.eticaStableSwapAbi,
        functionName: 'setAdminFeeRecipient',
        args: [adapterAddr],
      });
      setSetRecipientState({ status: 'pending', txHash: hash });
      const r = await publicClient.waitForTransactionReceipt({ hash });
      if (r.status !== 'success') {
        setSetRecipientState({ status: 'error', txHash: hash, error: 'Reverted' });
        return;
      }
      setSetRecipientState({ status: 'confirmed', txHash: hash });
    } catch (err) {
      setSetRecipientState({ status: 'error', error: shortError(err) });
    }
  }

  const injected = connectors.find((c) => c.id === 'injected') ?? connectors[0];

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-white/10 bg-white/5 p-5 text-sm text-white/70">
        <h2 className="mb-2 text-lg font-semibold text-white">What this deploys</h2>
        <p>
          A rate-aware Curve-style stableswap pool for stETX/ETX, a 10-year lock contract for the
          treasury seed LP shares only, and a permissionless harvester adapter that streams the
          admin-fee slice through the existing 10/10/40/40 TreasuryHarvester pattern. Public LPs are
          never locked. Fees never enter the timelock.
        </p>
        <p className="mt-2">
          Compiled with <span className="font-mono">{poolArtifact.version}</span>. Reads{' '}
          <span className="font-mono">stETX.convertToAssets(1e18)</span> live so the peg permanently
          tracks NAV. Default A=200, swap fee 4 bps, admin slice 50%.
        </p>
      </section>

      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-3 text-lg font-semibold">Wallet</h2>
        {!isConnected ? (
          <button
            type="button"
            className="rounded-md bg-emerald-500/90 px-4 py-2 text-sm font-medium text-black transition hover:bg-emerald-400 disabled:opacity-40"
            onClick={() => injected && connect({ connector: injected })}
            disabled={connectStatus === 'pending' || !injected}
          >
            {connectStatus === 'pending' ? 'Connecting…' : 'Connect wallet'}
          </button>
        ) : (
          <div className="space-y-2 text-sm">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-white/60">Connected:</span>
              <span className="font-mono break-all">{address}</span>
              <button
                type="button"
                className="ml-auto rounded-md border border-white/15 px-3 py-1 text-xs text-white/70 hover:bg-white/5"
                onClick={() => disconnect()}
              >
                Disconnect
              </button>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-white/60">Chain:</span>
              <span className="font-mono">{chainId}</span>
              {!onMainnet && (
                <button
                  type="button"
                  className="rounded-md bg-amber-400/90 px-3 py-1 text-xs font-medium text-black hover:bg-amber-300"
                  onClick={() => switchChain({ chainId: eticaMainnet.id })}
                  disabled={switching}
                >
                  {switching ? 'Switching…' : 'Switch to Etica Mainnet'}
                </button>
              )}
            </div>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-3 text-lg font-semibold">Constructor inputs</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label="Treasury / pool owner"
            value={ownerInput}
            onChange={(v) => {
              ownerEdited.current = true;
              setOwnerInput(v);
            }}
            mono
          />
          <Field
            label="A coefficient"
            value={aInput}
            onChange={setAInput}
            placeholder="200"
            mono={false}
          />
          <Field
            label="ETX address"
            value={etxInput}
            onChange={(v) => {
              etxEdited.current = true;
              setEtxInput(v);
            }}
            mono
          />
          <Field
            label="stETX (ERC-4626) address"
            value={stEtxInput}
            onChange={(v) => {
              stEtxEdited.current = true;
              setStEtxInput(v);
            }}
            mono
          />
          <Field
            label="staked-ETX reward sink (10%)"
            value={stakedSinkInput}
            onChange={(v) => {
              stakedSinkEdited.current = true;
              setStakedSinkInput(v);
            }}
            mono
          />
          <Field
            label="ETXFarms reward sink (10%)"
            value={farmsSinkInput}
            onChange={(v) => {
              farmsSinkEdited.current = true;
              setFarmsSinkInput(v);
            }}
            mono
          />
          <Field
            label="Treasury wallet (40% retained)"
            value={treasuryInput}
            onChange={(v) => {
              treasuryEdited.current = true;
              setTreasuryInput(v);
            }}
            mono
          />
          <Field
            label="Seed amount per leg (ETX)"
            value={seedAmountHuman}
            onChange={setSeedAmountHuman}
            placeholder="15000000"
            mono={false}
          />
        </div>
        {!aValue && <p className="mt-2 text-xs text-amber-300/80">A must be a positive integer.</p>}
        {!seedAmount && (
          <p className="mt-2 text-xs text-amber-300/80">Seed amount must be a positive number.</p>
        )}
      </section>

      <Step
        n={1}
        title="Deploy EticaStableSwap pool"
        body="Deploys the rate-aware AMM. Owner is the treasury multisig; mints zero LP supply at construction."
        button="Deploy pool"
        state={poolState}
        disabled={
          !isConnected ||
          !walletClient ||
          !parsedOwner ||
          !parsedEtx ||
          !parsedStEtx ||
          !aValue ||
          poolState.status === 'pending' ||
          poolState.status === 'confirmed'
        }
        onClick={deployPool}
      />

      <Step
        n={2}
        title="Deploy LiquidityTimelock10y"
        body="Pure LP-share holder for the treasury seed. unlockTime is set to deploy.timestamp + 10 years."
        button="Deploy timelock"
        state={timelockState}
        disabled={
          !isConnected ||
          !walletClient ||
          !parsedOwner ||
          !poolAddr ||
          timelockState.status === 'pending' ||
          timelockState.status === 'confirmed'
        }
        onClick={deployTimelock}
      />

      <Step
        n={3}
        title="Deploy StableSwapHarvesterAdapter"
        body="Permissionless harvest crank. Routes admin fees through the 10/10/40/40 split with permanent POL burn into the stableswap pool itself."
        button="Deploy adapter"
        state={adapterState}
        disabled={
          !isConnected ||
          !walletClient ||
          !parsedOwner ||
          !poolAddr ||
          !parsedEtx ||
          !parsedStEtx ||
          !parsedStakedSink ||
          !parsedFarmsSink ||
          !parsedTreasury ||
          adapterState.status === 'pending' ||
          adapterState.status === 'confirmed'
        }
        onClick={deployAdapter}
      />

      <Step
        n={4}
        title="Approve ETX → stETX vault"
        body="Authorises the stETX vault to pull ETX for the seed deposit."
        button="Approve ETX → stETX"
        state={approveEtxState}
        disabled={
          !isConnected ||
          !walletClient ||
          !parsedEtx ||
          !parsedStEtx ||
          approveEtxState.status === 'pending'
        }
        onClick={doApproveEtx}
      />

      <Step
        n={5}
        title={`Deposit ${SEED_AMOUNT_HUMAN} ETX into stETX vault`}
        body="Mints stETX shares back to the deployer wallet. Real on-chain deposit; spends seed ETX."
        button={`Deposit ${seedAmountHuman || '0'} ETX`}
        state={stakeState}
        disabled={
          !isConnected ||
          !walletClient ||
          !parsedStEtx ||
          !seedAmount ||
          approveEtxState.status !== 'confirmed' ||
          stakeState.status === 'pending'
        }
        onClick={doStake}
      />

      <Step
        n={6}
        title="Approve ETX + stETX → pool"
        body="Two approvals in one click. Authorises the pool to pull both seed legs."
        button="Approve both"
        state={approveStEtxState}
        disabled={
          !isConnected ||
          !walletClient ||
          !poolAddr ||
          !parsedEtx ||
          !parsedStEtx ||
          approveStEtxState.status === 'pending'
        }
        onClick={doApprovePool}
      />

      <Step
        n={7}
        title={`Seed pool with ${seedAmountHuman} ETX + ${seedAmountHuman} stETX → timelock`}
        body="Mints esLP shares directly into the LiquidityTimelock10y contract. Public LPs can join later from /pool with no lock; only this seed is locked."
        button="Seed pool"
        state={seedState}
        disabled={
          !isConnected ||
          !walletClient ||
          !poolAddr ||
          !timelockAddr ||
          !seedAmount ||
          approveStEtxState.status !== 'confirmed' ||
          seedState.status === 'pending'
        }
        onClick={doSeed}
      />

      <Step
        n={8}
        title="Pin lockedAmount on timelock"
        body={
          pendingLpAtTreasury !== null && pendingLpAtTreasury > 0n
            ? `Sets the immutable lock floor at ${formatUnits(pendingLpAtTreasury, 18)} esLP — exactly the seed mint. Cannot be raised later.`
            : 'Reads the timelock LP balance, then pins it as the immutable 10-year lock floor.'
        }
        button="Pin lockedAmount"
        state={setLockState}
        disabled={
          !isConnected ||
          !walletClient ||
          !timelockAddr ||
          !pendingLpAtTreasury ||
          pendingLpAtTreasury === 0n ||
          seedState.status !== 'confirmed' ||
          setLockState.status === 'pending'
        }
        onClick={doSetLock}
      />

      <Step
        n={9}
        title="Wire admin-fee recipient → adapter"
        body="Calls setAdminFeeRecipient(adapter) on the pool. Owner-only. After this, claimAdminFees() routes fees through 10/10/40/40."
        button="Wire fee recipient"
        state={setRecipientState}
        disabled={
          !isConnected ||
          !walletClient ||
          !poolAddr ||
          !adapterAddr ||
          setRecipientState.status === 'pending'
        }
        onClick={doSetRecipient}
      />

      {(poolAddr || timelockAddr || adapterAddr) && (
        <section className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 p-5 text-sm text-emerald-100">
          <h2 className="mb-3 text-base font-semibold text-emerald-200">Deployment record</h2>
          <ul className="space-y-1 font-mono text-xs">
            {poolAddr && (
              <li>
                eticaStableSwap: <span className="break-all">{poolAddr}</span>
              </li>
            )}
            {timelockAddr && (
              <li>
                liquidityTimelock10y: <span className="break-all">{timelockAddr}</span>
              </li>
            )}
            {adapterAddr && (
              <li>
                stableSwapHarvesterAdapter: <span className="break-all">{adapterAddr}</span>
              </li>
            )}
          </ul>
          <p className="mt-3 text-xs text-emerald-100/80">
            Paste these into{' '}
            <span className="font-mono">packages/shared/src/addresses.ts</span> under{' '}
            <span className="font-mono">DEPLOYMENTS[{chainId}]</span>.
          </p>
        </section>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  mono = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <label className="block text-xs text-white/70">
      {label}
      <input
        type="text"
        className={`mt-1 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-xs text-white placeholder:text-white/30 ${mono ? 'font-mono' : ''}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
      />
    </label>
  );
}

function Step({
  n,
  title,
  body,
  button,
  state,
  disabled,
  onClick,
}: {
  n: number;
  title: string;
  body: string;
  button: string;
  state: TxState;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <section className="rounded-xl border border-white/10 bg-white/5 p-5">
      <h2 className="mb-1 text-sm font-semibold text-white/90">
        Step {n} · {title}
      </h2>
      <p className="mb-3 text-xs text-white/60">{body}</p>
      <button
        type="button"
        className="rounded-md bg-emerald-500/90 px-4 py-2 text-sm font-medium text-black transition hover:bg-emerald-400 disabled:opacity-40"
        onClick={onClick}
        disabled={disabled}
      >
        {state.status === 'signing'
          ? 'Sign in wallet…'
          : state.status === 'pending'
            ? 'Waiting for confirmation…'
            : state.status === 'confirmed'
              ? 'Done'
              : button}
      </button>
      <StateBadge state={state} label={`Step ${n}`} />
    </section>
  );
}
