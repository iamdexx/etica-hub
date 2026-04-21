'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  BaseError,
  UserRejectedRequestError,
  isAddress,
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
import { DEPLOYMENTS, TREASURY_ADDRESS } from '@etica-hub/shared';
import { eticaMainnet } from '@etica-hub/shared/chains';
import {
  feeControllerArtifact,
  reactorArtifact,
} from '@/lib/trading-deploy-artifacts';

const feeControllerAbi = feeControllerArtifact.abi;
const reactorAbi = reactorArtifact.abi;

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

type TxState = {
  status: 'idle' | 'signing' | 'pending' | 'confirmed' | 'error';
  txHash?: Hex;
  error?: string;
};

const initial: TxState = { status: 'idle' };

function shortError(err: unknown): string {
  if (err instanceof UserRejectedRequestError) return 'Rejected in wallet.';
  if (err instanceof BaseError) return err.shortMessage ?? err.message;
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

function ShortAddr({ value }: { value: Address | undefined | null }) {
  if (!value) return <span className="font-mono text-white/40">—</span>;
  if (value === ZERO_ADDRESS) return <span className="font-mono text-amber-300">0x0 (unset)</span>;
  return (
    <a
      href={`https://eticascan.org/address/${value}`}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-emerald-400 hover:underline"
    >
      {value}
    </a>
  );
}

function TxLink({ hash }: { hash: Hex | undefined }) {
  if (!hash) return null;
  return (
    <a
      href={`https://eticascan.org/tx/${hash}`}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-emerald-400 hover:underline"
    >
      {hash.slice(0, 10)}…{hash.slice(-6)}
    </a>
  );
}

function StateBadge({ state }: { state: TxState }) {
  if (state.status === 'idle') return null;
  if (state.status === 'error' && state.error) {
    return (
      <div className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">
        {state.error}
        {state.txHash && (
          <>
            {' · '}
            <TxLink hash={state.txHash} />
          </>
        )}
      </div>
    );
  }
  return (
    <div className="mt-3 text-xs text-white/60">
      {state.status === 'signing' && 'Confirm in wallet…'}
      {state.status === 'pending' && (
        <>
          Pending: <TxLink hash={state.txHash} />
        </>
      )}
      {state.status === 'confirmed' && (
        <span className="text-emerald-400">
          Confirmed: <TxLink hash={state.txHash} />
        </span>
      )}
    </div>
  );
}

export function AdminReactorCard() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { connectors, connect, status: connectStatus } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();

  const onMainnet = chainId === eticaMainnet.id;
  const reactor = DEPLOYMENTS[eticaMainnet.id].dutchReactor as Address;
  const feeController = DEPLOYMENTS[eticaMainnet.id].etxFeeController as Address;

  const reactorDeployed = reactor !== ZERO_ADDRESS;
  const feeControllerDeployed = feeController !== ZERO_ADDRESS;

  // --- Live reads ---
  const [controllerFeeBps, setControllerFeeBps] = useState<bigint | null>(null);
  const [feeCapBps, setFeeCapBps] = useState<bigint | null>(null);
  const [controllerTreasury, setControllerTreasury] = useState<Address | null>(null);
  const [controllerOwner, setControllerOwner] = useState<Address | null>(null);
  const [controllerEtx, setControllerEtx] = useState<Address | null>(null);
  const [reactorFeeController, setReactorFeeController] = useState<Address | null>(null);
  const [reactorOwner, setReactorOwner] = useState<Address | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    if (!publicClient || !onMainnet) return;
    let cancelled = false;

    (async () => {
      try {
        if (feeControllerDeployed) {
          const [bps, cap, treas, own, etx] = await Promise.all([
            publicClient.readContract({
              address: feeController,
              abi: feeControllerAbi,
              functionName: 'feeBps',
            }),
            publicClient.readContract({
              address: feeController,
              abi: feeControllerAbi,
              functionName: 'FEE_CAP_BPS',
            }),
            publicClient.readContract({
              address: feeController,
              abi: feeControllerAbi,
              functionName: 'treasury',
            }),
            publicClient.readContract({
              address: feeController,
              abi: feeControllerAbi,
              functionName: 'owner',
            }),
            publicClient.readContract({
              address: feeController,
              abi: feeControllerAbi,
              functionName: 'ETX',
            }),
          ]);
          if (cancelled) return;
          setControllerFeeBps(bps as bigint);
          setFeeCapBps(cap as bigint);
          setControllerTreasury(treas as Address);
          setControllerOwner(own as Address);
          setControllerEtx(etx as Address);
        }
        if (reactorDeployed) {
          const [fc, own] = await Promise.all([
            publicClient.readContract({
              address: reactor,
              abi: reactorAbi,
              functionName: 'feeController',
            }),
            publicClient.readContract({
              address: reactor,
              abi: reactorAbi,
              functionName: 'owner',
            }),
          ]);
          if (cancelled) return;
          setReactorFeeController(fc as Address);
          setReactorOwner(own as Address);
        }
      } catch {
        // leave nulls
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [publicClient, onMainnet, feeController, reactor, feeControllerDeployed, reactorDeployed, reloadTick]);

  const isControllerAuthorized =
    isConnected &&
    onMainnet &&
    !!address &&
    !!controllerOwner &&
    address.toLowerCase() === controllerOwner.toLowerCase();

  const isReactorAuthorized =
    isConnected &&
    onMainnet &&
    !!address &&
    !!reactorOwner &&
    address.toLowerCase() === reactorOwner.toLowerCase();

  // --- setFeeBps ---
  const [bpsInput, setBpsInput] = useState<string>('0');
  const bpsValid = useMemo<bigint | null>(() => {
    const t = bpsInput.trim();
    if (!/^\d+$/.test(t)) return null;
    try {
      const v = BigInt(t);
      if (feeCapBps !== null && v > feeCapBps) return null;
      return v;
    } catch {
      return null;
    }
  }, [bpsInput, feeCapBps]);
  const [bpsState, setBpsState] = useState<TxState>(initial);

  async function doSetFeeBps() {
    if (!walletClient || !publicClient || bpsValid === null || !isControllerAuthorized) return;
    setBpsState({ status: 'signing' });
    try {
      const hash = await walletClient.writeContract({
        address: feeController,
        abi: feeControllerAbi,
        functionName: 'setFeeBps',
        args: [bpsValid],
      });
      setBpsState({ status: 'pending', txHash: hash });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        setBpsState({ status: 'error', txHash: hash, error: 'Reverted on-chain' });
      } else {
        setBpsState({ status: 'confirmed', txHash: hash });
        setReloadTick((x) => x + 1);
      }
    } catch (err) {
      setBpsState({ status: 'error', error: shortError(err) });
    }
  }

  // --- setTreasury ---
  const [treasuryInput, setTreasuryInput] = useState<string>(TREASURY_ADDRESS);
  const treasuryValid = useMemo<Address | null>(() => {
    const t = treasuryInput.trim();
    return isAddress(t) ? (t as Address) : null;
  }, [treasuryInput]);
  const [treasuryState, setTreasuryState] = useState<TxState>(initial);

  async function doSetTreasury() {
    if (!walletClient || !publicClient || !treasuryValid || !isControllerAuthorized) return;
    setTreasuryState({ status: 'signing' });
    try {
      const hash = await walletClient.writeContract({
        address: feeController,
        abi: feeControllerAbi,
        functionName: 'setTreasury',
        args: [treasuryValid],
      });
      setTreasuryState({ status: 'pending', txHash: hash });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        setTreasuryState({ status: 'error', txHash: hash, error: 'Reverted on-chain' });
      } else {
        setTreasuryState({ status: 'confirmed', txHash: hash });
        setReloadTick((x) => x + 1);
      }
    } catch (err) {
      setTreasuryState({ status: 'error', error: shortError(err) });
    }
  }

  // --- setOwner (on controller) ---
  const [ownerInput, setOwnerInput] = useState<string>('');
  const ownerValid = useMemo<Address | null>(() => {
    const t = ownerInput.trim();
    return isAddress(t) ? (t as Address) : null;
  }, [ownerInput]);
  const [ownerState, setOwnerState] = useState<TxState>(initial);

  async function doSetOwner() {
    if (!walletClient || !publicClient || !ownerValid || !isControllerAuthorized) return;
    setOwnerState({ status: 'signing' });
    try {
      const hash = await walletClient.writeContract({
        address: feeController,
        abi: feeControllerAbi,
        functionName: 'setOwner',
        args: [ownerValid],
      });
      setOwnerState({ status: 'pending', txHash: hash });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        setOwnerState({ status: 'error', txHash: hash, error: 'Reverted on-chain' });
      } else {
        setOwnerState({ status: 'confirmed', txHash: hash });
        setReloadTick((x) => x + 1);
      }
    } catch (err) {
      setOwnerState({ status: 'error', error: shortError(err) });
    }
  }

  // --- setProtocolFeeController (on reactor) ---
  const [controllerInput, setControllerInput] = useState<string>('');
  const controllerValid = useMemo<Address | null>(() => {
    const t = controllerInput.trim();
    return isAddress(t) ? (t as Address) : null;
  }, [controllerInput]);
  const [pfcState, setPfcState] = useState<TxState>(initial);

  async function doSetProtocolFeeController() {
    if (!walletClient || !publicClient || !controllerValid || !isReactorAuthorized) return;
    setPfcState({ status: 'signing' });
    try {
      const hash = await walletClient.writeContract({
        address: reactor,
        abi: reactorAbi,
        functionName: 'setProtocolFeeController',
        args: [controllerValid],
      });
      setPfcState({ status: 'pending', txHash: hash });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        setPfcState({ status: 'error', txHash: hash, error: 'Reverted on-chain' });
      } else {
        setPfcState({ status: 'confirmed', txHash: hash });
        setReloadTick((x) => x + 1);
      }
    } catch (err) {
      setPfcState({ status: 'error', error: shortError(err) });
    }
  }

  const injectedConnector = connectors.find((c) => c.id === 'injected') ?? connectors[0];

  if (!reactorDeployed && !feeControllerDeployed) {
    return (
      <section className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-5 text-sm text-amber-200">
        <h2 className="mb-2 text-lg font-semibold">Reactor not deployed yet</h2>
        <p className="text-amber-100/80">
          The UniswapX DutchOrderReactor and EticaProtocolFeeController have not been deployed on
          Etica Mainnet yet. Deploy them via{' '}
          <a href="/deploy/trading" className="underline">
            /deploy/trading
          </a>{' '}
          (operator-only, signs with your wallet), then the resulting addresses get wired into
          <code className="mx-1 font-mono">packages/shared/src/addresses.ts</code>
          in a follow-up PR and this page will go live.
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-6">
      {/* Wallet */}
      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-3 text-lg font-semibold">Wallet</h2>
        {!isConnected && (
          <button
            onClick={() => injectedConnector && connect({ connector: injectedConnector })}
            disabled={!injectedConnector || connectStatus === 'pending'}
            className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-black hover:bg-emerald-400 disabled:opacity-50"
          >
            {connectStatus === 'pending' ? 'Connecting…' : 'Connect MetaMask'}
          </button>
        )}
        {isConnected && (
          <div className="space-y-3 text-sm">
            <div className="font-mono break-all text-white/80">{address}</div>
            <div>
              Chain:{' '}
              <span className={onMainnet ? 'text-emerald-400' : 'text-amber-400'}>
                {onMainnet ? 'Etica Mainnet (61803)' : `Wrong network (${chainId})`}
              </span>
            </div>
            {!onMainnet && (
              <button
                onClick={() => switchChain({ chainId: eticaMainnet.id })}
                disabled={switching}
                className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-medium text-black hover:bg-amber-400 disabled:opacity-50"
              >
                {switching ? 'Switching…' : 'Switch to Etica Mainnet'}
              </button>
            )}
            <button
              onClick={() => disconnect()}
              className="ml-2 rounded-lg border border-white/20 px-3 py-1.5 text-xs font-medium text-white/70 hover:bg-white/10"
            >
              Disconnect
            </button>
            {onMainnet && feeControllerDeployed && controllerOwner && !isControllerAuthorized && (
              <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                Connected wallet is not the fee controller <span className="font-mono">owner</span>.
                Controller writes are disabled. Expected:{' '}
                <span className="font-mono">{controllerOwner}</span>
              </div>
            )}
            {onMainnet && reactorDeployed && reactorOwner && !isReactorAuthorized && (
              <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                Connected wallet is not the reactor <span className="font-mono">owner</span>.
                <code className="mx-1 font-mono">setProtocolFeeController</code> is disabled.
                Expected: <span className="font-mono">{reactorOwner}</span>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Current state */}
      <section className="rounded-xl border border-white/10 bg-white/5 p-5 text-sm">
        <h2 className="mb-3 text-lg font-semibold">Current reactor + fee controller state</h2>
        <dl className="grid grid-cols-1 gap-y-2 md:grid-cols-[220px_1fr] md:gap-x-4">
          <dt className="text-white/50">Reactor</dt>
          <dd>
            <ShortAddr value={reactorDeployed ? reactor : null} />
          </dd>
          <dt className="text-white/50">reactor.owner()</dt>
          <dd>
            <ShortAddr value={reactorOwner} />
          </dd>
          <dt className="text-white/50">reactor.feeController()</dt>
          <dd>
            <ShortAddr value={reactorFeeController} />
          </dd>
          <dt className="text-white/50">Fee controller</dt>
          <dd>
            <ShortAddr value={feeControllerDeployed ? feeController : null} />
          </dd>
          <dt className="text-white/50">controller.ETX()</dt>
          <dd>
            <ShortAddr value={controllerEtx} />
          </dd>
          <dt className="text-white/50">controller.owner()</dt>
          <dd>
            <ShortAddr value={controllerOwner} />
          </dd>
          <dt className="text-white/50">controller.treasury()</dt>
          <dd>
            <ShortAddr value={controllerTreasury} />
          </dd>
          <dt className="text-white/50">controller.feeBps()</dt>
          <dd className="font-mono">
            {controllerFeeBps === null
              ? '—'
              : controllerFeeBps === 0n
                ? '0 bps (fees off)'
                : `${controllerFeeBps.toString()} bps`}
          </dd>
          <dt className="text-white/50">controller.FEE_CAP_BPS</dt>
          <dd className="font-mono">{feeCapBps?.toString() ?? '—'} bps (hard cap)</dd>
        </dl>
        <button
          onClick={() => setReloadTick((x) => x + 1)}
          className="mt-3 rounded-lg border border-white/20 px-3 py-1.5 text-xs text-white/70 hover:bg-white/10"
        >
          Refresh
        </button>
      </section>

      {feeControllerDeployed && (
        <>
          {/* setFeeBps */}
          <section className="rounded-xl border border-white/10 bg-white/5 p-5">
            <h2 className="mb-3 text-lg font-semibold">setFeeBps</h2>
            <p className="mb-3 text-sm text-white/60">
              Sets the ETX protocol fee in basis points (1 bps = 0.01%). Charged on the ETX leg of
              every fill, paid to <code className="font-mono">treasury</code>. Hard-capped at{' '}
              <span className="font-mono">{feeCapBps?.toString() ?? '100'}</span> bps on-chain.
              Leave at <span className="font-mono">0</span> to keep fees off.
            </p>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={bpsInput}
                onChange={(e) => setBpsInput(e.target.value)}
                spellCheck={false}
                className="w-48 rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm outline-none focus:border-emerald-500"
                placeholder="0"
              />
              <span className="text-sm text-white/60">bps</span>
            </div>
            {bpsValid === null && bpsInput.trim() !== '' && (
              <div className="mt-1 text-xs text-red-400">
                Enter an integer from 0 to {feeCapBps?.toString() ?? '100'}.
              </div>
            )}
            <div className="mt-3 flex justify-end">
              <button
                onClick={doSetFeeBps}
                disabled={
                  !isControllerAuthorized ||
                  bpsValid === null ||
                  bpsState.status === 'signing' ||
                  bpsState.status === 'pending'
                }
                className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-black hover:bg-emerald-400 disabled:opacity-40"
              >
                {bpsState.status === 'signing'
                  ? 'Confirm in wallet…'
                  : bpsState.status === 'pending'
                    ? 'Confirming…'
                    : 'Call setFeeBps'}
              </button>
            </div>
            <StateBadge state={bpsState} />
          </section>

          {/* setTreasury */}
          <section className="rounded-xl border border-white/10 bg-white/5 p-5">
            <h2 className="mb-3 text-lg font-semibold">setTreasury</h2>
            <p className="mb-3 text-sm text-white/60">
              Rotates the recipient of the ETX protocol fee. Zero address is rejected on-chain.
            </p>
            <input
              type="text"
              value={treasuryInput}
              onChange={(e) => setTreasuryInput(e.target.value)}
              spellCheck={false}
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm outline-none focus:border-emerald-500"
              placeholder="0x…"
            />
            {!treasuryValid && (
              <div className="mt-1 text-xs text-red-400">Not a valid address.</div>
            )}
            <div className="mt-3 flex justify-end">
              <button
                onClick={doSetTreasury}
                disabled={
                  !isControllerAuthorized ||
                  !treasuryValid ||
                  treasuryState.status === 'signing' ||
                  treasuryState.status === 'pending'
                }
                className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-black hover:bg-emerald-400 disabled:opacity-40"
              >
                {treasuryState.status === 'signing'
                  ? 'Confirm in wallet…'
                  : treasuryState.status === 'pending'
                    ? 'Confirming…'
                    : 'Call setTreasury'}
              </button>
            </div>
            <StateBadge state={treasuryState} />
          </section>

          {/* setOwner on controller */}
          <section className="rounded-xl border border-white/10 bg-white/5 p-5">
            <h2 className="mb-3 text-lg font-semibold">setOwner (fee controller)</h2>
            <p className="mb-3 text-sm text-amber-300/80">
              Danger: rotates the fee controller&apos;s admin key. The new address becomes the
              only wallet allowed to call <code className="font-mono">setFeeBps</code>,{' '}
              <code className="font-mono">setTreasury</code>, and{' '}
              <code className="font-mono">setOwner</code>. Typically used once to migrate from an
              EOA to a multisig.
            </p>
            <input
              type="text"
              value={ownerInput}
              onChange={(e) => setOwnerInput(e.target.value)}
              spellCheck={false}
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm outline-none focus:border-emerald-500"
              placeholder="0x… new owner"
            />
            {!ownerValid && ownerInput.trim() !== '' && (
              <div className="mt-1 text-xs text-red-400">Not a valid address.</div>
            )}
            <div className="mt-3 flex justify-end">
              <button
                onClick={doSetOwner}
                disabled={
                  !isControllerAuthorized ||
                  !ownerValid ||
                  ownerState.status === 'signing' ||
                  ownerState.status === 'pending'
                }
                className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-black hover:bg-amber-400 disabled:opacity-40"
              >
                {ownerState.status === 'signing'
                  ? 'Confirm in wallet…'
                  : ownerState.status === 'pending'
                    ? 'Confirming…'
                    : 'Call setOwner'}
              </button>
            </div>
            <StateBadge state={ownerState} />
          </section>
        </>
      )}

      {reactorDeployed && (
        <section className="rounded-xl border border-white/10 bg-white/5 p-5">
          <h2 className="mb-3 text-lg font-semibold">setProtocolFeeController (reactor)</h2>
          <p className="mb-3 text-sm text-white/60">
            Replaces the entire fee-controller contract wired into the reactor. Use this if you
            need to deploy a new controller implementation; otherwise prefer rotating parameters on
            the existing controller above.
          </p>
          <input
            type="text"
            value={controllerInput}
            onChange={(e) => setControllerInput(e.target.value)}
            spellCheck={false}
            className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm outline-none focus:border-emerald-500"
            placeholder="0x… new fee controller"
          />
          {!controllerValid && controllerInput.trim() !== '' && (
            <div className="mt-1 text-xs text-red-400">Not a valid address.</div>
          )}
          <div className="mt-3 flex justify-end">
            <button
              onClick={doSetProtocolFeeController}
              disabled={
                !isReactorAuthorized ||
                !controllerValid ||
                pfcState.status === 'signing' ||
                pfcState.status === 'pending'
              }
              className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-black hover:bg-emerald-400 disabled:opacity-40"
            >
              {pfcState.status === 'signing'
                ? 'Confirm in wallet…'
                : pfcState.status === 'pending'
                  ? 'Confirming…'
                  : 'Call setProtocolFeeController'}
            </button>
          </div>
          <StateBadge state={pfcState} />
        </section>
      )}
    </div>
  );
}
