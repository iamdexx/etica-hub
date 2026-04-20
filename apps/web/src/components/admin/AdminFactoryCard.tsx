'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  BaseError,
  UserRejectedRequestError,
  formatUnits,
  isAddress,
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

const factoryAbi = abis.factoryAbi;

type TxState = {
  status: 'idle' | 'signing' | 'pending' | 'confirmed' | 'error';
  txHash?: Hex;
  error?: string;
};

const initial: TxState = { status: 'idle' };

function shortError(err: unknown): string {
  if (err instanceof UserRejectedRequestError) return 'Rejected in wallet.';
  if (err instanceof BaseError) return (err.shortMessage ?? err.message);
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

function ShortAddr({ value }: { value: Address | undefined | null }) {
  if (!value) return <span className="font-mono text-white/40">—</span>;
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

export function AdminFactoryCard() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { connectors, connect, status: connectStatus } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();

  const onMainnet = chainId === eticaMainnet.id;
  const factory = DEPLOYMENTS[eticaMainnet.id].swapFactory as Address;

  // Live reads
  const [feeTo, setFeeTo] = useState<Address | null>(null);
  const [feeToSetter, setFeeToSetter] = useState<Address | null>(null);
  const [etx, setEtx] = useState<Address | null>(null);
  const [pairCreationFee, setPairCreationFee] = useState<bigint | null>(null);
  const [allPairsLength, setAllPairsLength] = useState<bigint | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    if (!publicClient || !onMainnet) return;
    let cancelled = false;
    (async () => {
      try {
        const [ft, fts, e, pcf, apl] = await Promise.all([
          publicClient.readContract({
            address: factory,
            abi: factoryAbi,
            functionName: 'feeTo',
          }),
          publicClient.readContract({
            address: factory,
            abi: factoryAbi,
            functionName: 'feeToSetter',
          }),
          publicClient.readContract({
            address: factory,
            abi: factoryAbi,
            functionName: 'etx',
          }),
          publicClient.readContract({
            address: factory,
            abi: factoryAbi,
            functionName: 'pairCreationFee',
          }),
          publicClient.readContract({
            address: factory,
            abi: factoryAbi,
            functionName: 'allPairsLength',
          }),
        ]);
        if (cancelled) return;
        setFeeTo(ft as Address);
        setFeeToSetter(fts as Address);
        setEtx(e as Address);
        setPairCreationFee(pcf as bigint);
        setAllPairsLength(apl as bigint);
      } catch {
        // leave nulls
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, onMainnet, factory, reloadTick]);

  const isAuthorized =
    isConnected &&
    onMainnet &&
    !!address &&
    !!feeToSetter &&
    address.toLowerCase() === feeToSetter.toLowerCase();

  // --- setFeeTo ---
  const [feeToInput, setFeeToInput] = useState<string>(TREASURY_ADDRESS);
  const feeToValid = useMemo<Address | null>(() => {
    const t = feeToInput.trim();
    return isAddress(t) ? (t as Address) : null;
  }, [feeToInput]);
  const [setFeeToState, setSetFeeToState] = useState<TxState>(initial);

  async function doSetFeeTo() {
    if (!walletClient || !publicClient || !feeToValid || !isAuthorized) return;
    setSetFeeToState({ status: 'signing' });
    try {
      const hash = await walletClient.writeContract({
        address: factory,
        abi: factoryAbi,
        functionName: 'setFeeTo',
        args: [feeToValid],
      });
      setSetFeeToState({ status: 'pending', txHash: hash });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        setSetFeeToState({ status: 'error', txHash: hash, error: 'Reverted on-chain' });
      } else {
        setSetFeeToState({ status: 'confirmed', txHash: hash });
        setReloadTick((x) => x + 1);
      }
    } catch (err) {
      setSetFeeToState({ status: 'error', error: shortError(err) });
    }
  }

  // --- setTrustedCreator ---
  const [tcInput, setTcInput] = useState<string>('');
  const [tcFlag, setTcFlag] = useState<boolean>(true);
  const tcValid = useMemo<Address | null>(() => {
    const t = tcInput.trim();
    return isAddress(t) ? (t as Address) : null;
  }, [tcInput]);
  const [tcState, setTcState] = useState<TxState>(initial);

  async function doSetTrustedCreator() {
    if (!walletClient || !publicClient || !tcValid || !isAuthorized) return;
    setTcState({ status: 'signing' });
    try {
      const hash = await walletClient.writeContract({
        address: factory,
        abi: factoryAbi,
        functionName: 'setTrustedCreator',
        args: [tcValid, tcFlag],
      });
      setTcState({ status: 'pending', txHash: hash });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        setTcState({ status: 'error', txHash: hash, error: 'Reverted on-chain' });
      } else {
        setTcState({ status: 'confirmed', txHash: hash });
        setReloadTick((x) => x + 1);
      }
    } catch (err) {
      setTcState({ status: 'error', error: shortError(err) });
    }
  }

  // --- setPairCreationFee ---
  const [feeInput, setFeeInput] = useState<string>('10000');
  const feeValid = useMemo<bigint | null>(() => {
    const t = feeInput.trim();
    if (!t) return null;
    try {
      const v = parseUnits(t, 18);
      return v >= 0n ? v : null;
    } catch {
      return null;
    }
  }, [feeInput]);
  const [feeState, setFeeState] = useState<TxState>(initial);

  async function doSetPairCreationFee() {
    if (!walletClient || !publicClient || feeValid === null || !isAuthorized) return;
    setFeeState({ status: 'signing' });
    try {
      const hash = await walletClient.writeContract({
        address: factory,
        abi: factoryAbi,
        functionName: 'setPairCreationFee',
        args: [feeValid],
      });
      setFeeState({ status: 'pending', txHash: hash });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        setFeeState({ status: 'error', txHash: hash, error: 'Reverted on-chain' });
      } else {
        setFeeState({ status: 'confirmed', txHash: hash });
        setReloadTick((x) => x + 1);
      }
    } catch (err) {
      setFeeState({ status: 'error', error: shortError(err) });
    }
  }

  // --- setFeeToSetter ---
  const [ftsInput, setFtsInput] = useState<string>('');
  const ftsValid = useMemo<Address | null>(() => {
    const t = ftsInput.trim();
    return isAddress(t) ? (t as Address) : null;
  }, [ftsInput]);
  const [ftsState, setFtsState] = useState<TxState>(initial);

  async function doSetFeeToSetter() {
    if (!walletClient || !publicClient || !ftsValid || !isAuthorized) return;
    setFtsState({ status: 'signing' });
    try {
      const hash = await walletClient.writeContract({
        address: factory,
        abi: factoryAbi,
        functionName: 'setFeeToSetter',
        args: [ftsValid],
      });
      setFtsState({ status: 'pending', txHash: hash });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        setFtsState({ status: 'error', txHash: hash, error: 'Reverted on-chain' });
      } else {
        setFtsState({ status: 'confirmed', txHash: hash });
        setReloadTick((x) => x + 1);
      }
    } catch (err) {
      setFtsState({ status: 'error', error: shortError(err) });
    }
  }

  const injectedConnector = connectors.find((c) => c.id === 'injected') ?? connectors[0];

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
            {onMainnet && feeToSetter && !isAuthorized && (
              <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                Connected wallet is not the current <span className="font-mono">feeToSetter</span>.
                All write buttons are disabled. Expected:{' '}
                <span className="font-mono">{feeToSetter}</span>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Current state */}
      <section className="rounded-xl border border-white/10 bg-white/5 p-5 text-sm">
        <h2 className="mb-3 text-lg font-semibold">Current factory state</h2>
        <dl className="grid grid-cols-1 gap-y-2 md:grid-cols-[200px_1fr] md:gap-x-4">
          <dt className="text-white/50">Factory</dt>
          <dd>
            <ShortAddr value={factory} />
          </dd>
          <dt className="text-white/50">etx()</dt>
          <dd>
            <ShortAddr value={etx} />
          </dd>
          <dt className="text-white/50">feeTo()</dt>
          <dd>
            {feeTo && feeTo !== '0x0000000000000000000000000000000000000000' ? (
              <ShortAddr value={feeTo} />
            ) : (
              <span className="font-mono text-amber-300">
                0x0 (bootstrap — no pool-creation fee charged)
              </span>
            )}
          </dd>
          <dt className="text-white/50">feeToSetter()</dt>
          <dd>
            <ShortAddr value={feeToSetter} />
          </dd>
          <dt className="text-white/50">pairCreationFee()</dt>
          <dd className="font-mono">
            {pairCreationFee === null
              ? '—'
              : `${formatUnits(pairCreationFee, 18)} ETX`}
          </dd>
          <dt className="text-white/50">allPairsLength()</dt>
          <dd className="font-mono">{allPairsLength?.toString() ?? '—'}</dd>
        </dl>
        <button
          onClick={() => setReloadTick((x) => x + 1)}
          className="mt-3 rounded-lg border border-white/20 px-3 py-1.5 text-xs text-white/70 hover:bg-white/10"
        >
          Refresh
        </button>
      </section>

      {/* setFeeTo */}
      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-3 text-lg font-semibold">setFeeTo</h2>
        <p className="mb-3 text-sm text-white/60">
          Sets the treasury recipient for the 10,000 ETX pool-creation fee and the 0.05% protocol
          swap fee. Set to the treasury wallet to turn fees <em>on</em>. Set to{' '}
          <span className="font-mono">0x0</span> to turn fees <em>off</em> (bootstrap).
        </p>
        <input
          type="text"
          value={feeToInput}
          onChange={(e) => setFeeToInput(e.target.value)}
          spellCheck={false}
          className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm outline-none focus:border-emerald-500"
          placeholder="0x…"
        />
        {!feeToValid && (
          <div className="mt-1 text-xs text-red-400">Not a valid address.</div>
        )}
        <div className="mt-3 flex justify-end">
          <button
            onClick={doSetFeeTo}
            disabled={!isAuthorized || !feeToValid || setFeeToState.status === 'signing' || setFeeToState.status === 'pending'}
            className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-black hover:bg-emerald-400 disabled:opacity-40"
          >
            {setFeeToState.status === 'signing'
              ? 'Confirm in wallet…'
              : setFeeToState.status === 'pending'
                ? 'Confirming…'
                : 'Call setFeeTo'}
          </button>
        </div>
        <StateBadge state={setFeeToState} />
      </section>

      {/* setTrustedCreator */}
      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-3 text-lg font-semibold">setTrustedCreator</h2>
        <p className="mb-3 text-sm text-white/60">
          Grants or revokes an address&apos;s permission to create pairs that don&apos;t include
          ETX. Only needed for the v2 launchpad (to allow <code>token/ETI</code> pools). Leave
          empty in v1.
        </p>
        <div className="flex flex-col gap-2 md:flex-row md:items-center">
          <input
            type="text"
            value={tcInput}
            onChange={(e) => setTcInput(e.target.value)}
            spellCheck={false}
            className="flex-1 rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm outline-none focus:border-emerald-500"
            placeholder="creator address 0x…"
          />
          <label className="flex items-center gap-2 text-sm text-white/80">
            <input
              type="checkbox"
              checked={tcFlag}
              onChange={(e) => setTcFlag(e.target.checked)}
              className="h-4 w-4"
            />
            trusted = <span className="font-mono">{tcFlag ? 'true' : 'false'}</span>
          </label>
        </div>
        {!tcValid && tcInput.trim() !== '' && (
          <div className="mt-1 text-xs text-red-400">Not a valid address.</div>
        )}
        <div className="mt-3 flex justify-end">
          <button
            onClick={doSetTrustedCreator}
            disabled={!isAuthorized || !tcValid || tcState.status === 'signing' || tcState.status === 'pending'}
            className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-black hover:bg-emerald-400 disabled:opacity-40"
          >
            {tcState.status === 'signing'
              ? 'Confirm in wallet…'
              : tcState.status === 'pending'
                ? 'Confirming…'
                : 'Call setTrustedCreator'}
          </button>
        </div>
        <StateBadge state={tcState} />
      </section>

      {/* setPairCreationFee */}
      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-3 text-lg font-semibold">setPairCreationFee</h2>
        <p className="mb-3 text-sm text-white/60">
          Changes the ETX amount charged on <code>createPair</code>. Enter the value in ETX (not
          wei). <span className="font-mono">0</span> disables the fee entirely.
        </p>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={feeInput}
            onChange={(e) => setFeeInput(e.target.value)}
            spellCheck={false}
            className="w-48 rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm outline-none focus:border-emerald-500"
            placeholder="10000"
          />
          <span className="text-sm text-white/60">ETX</span>
        </div>
        {feeValid === null && (
          <div className="mt-1 text-xs text-red-400">Not a valid amount.</div>
        )}
        <div className="mt-3 flex justify-end">
          <button
            onClick={doSetPairCreationFee}
            disabled={!isAuthorized || feeValid === null || feeState.status === 'signing' || feeState.status === 'pending'}
            className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-black hover:bg-emerald-400 disabled:opacity-40"
          >
            {feeState.status === 'signing'
              ? 'Confirm in wallet…'
              : feeState.status === 'pending'
                ? 'Confirming…'
                : 'Call setPairCreationFee'}
          </button>
        </div>
        <StateBadge state={feeState} />
      </section>

      {/* setFeeToSetter */}
      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-3 text-lg font-semibold">setFeeToSetter</h2>
        <p className="mb-3 text-sm text-amber-300/80">
          Danger: rotates the admin key. The new address becomes the only wallet allowed to call
          any of the setters on this page. Typically used once to migrate from an EOA to a
          multisig.
        </p>
        <input
          type="text"
          value={ftsInput}
          onChange={(e) => setFtsInput(e.target.value)}
          spellCheck={false}
          className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm outline-none focus:border-emerald-500"
          placeholder="new feeToSetter 0x…"
        />
        {!ftsValid && ftsInput.trim() !== '' && (
          <div className="mt-1 text-xs text-red-400">Not a valid address.</div>
        )}
        <div className="mt-3 flex justify-end">
          <button
            onClick={doSetFeeToSetter}
            disabled={!isAuthorized || !ftsValid || ftsState.status === 'signing' || ftsState.status === 'pending'}
            className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-black hover:bg-amber-400 disabled:opacity-40"
          >
            {ftsState.status === 'signing'
              ? 'Confirm in wallet…'
              : ftsState.status === 'pending'
                ? 'Confirming…'
                : 'Call setFeeToSetter'}
          </button>
        </div>
        <StateBadge state={ftsState} />
      </section>
    </div>
  );
}
