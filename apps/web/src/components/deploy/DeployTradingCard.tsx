'use client';

import { useMemo, useState } from 'react';
import {
  BaseError,
  UserRejectedRequestError,
  isAddress,
  type Abi,
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
  permit2Artifact,
  reactorArtifact,
} from '@/lib/trading-deploy-artifacts';

type StepKey = 'permit2' | 'reactor' | 'feeController' | 'wireController';

type DeployState = {
  status: 'idle' | 'signing' | 'pending' | 'confirmed' | 'error';
  txHash?: Hex;
  /** Only set for deploy steps (permit2, reactor, feeController). */
  address?: Address;
  error?: string;
};

const initial: DeployState = { status: 'idle' };

function shortError(err: unknown): string {
  if (err instanceof UserRejectedRequestError) return 'Rejected in wallet.';
  if (err instanceof BaseError) return err.shortMessage ?? err.message;
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

type Addresses = Partial<Record<StepKey, Address>>;

type StepConfig =
  | {
      kind: 'deploy';
      key: StepKey;
      label: string;
      description: string;
      abi: Abi;
      bytecode: Hex;
      args: (
        ctx: { treasury: Address; etx: Address; addresses: Addresses },
      ) => { ready: true; args: readonly unknown[] } | { ready: false; missing: string };
    }
  | {
      kind: 'call';
      key: StepKey;
      label: string;
      description: string;
      abi: Abi;
      functionName: string;
      target: (addresses: Addresses) => Address | null;
      args: (
        ctx: { treasury: Address; etx: Address; addresses: Addresses },
      ) => { ready: true; args: readonly unknown[] } | { ready: false; missing: string };
    };

const STEPS: StepConfig[] = [
  {
    kind: 'deploy',
    key: 'permit2',
    label: '1. Deploy Permit2',
    description:
      'Uniswap Labs Permit2 (verbatim, solc 0.8.17 + via_ir, audited by OpenZeppelin + ABDK + Trail of Bits). No constructor args. Deploys first — no dependencies.',
    abi: permit2Artifact.abi,
    bytecode: permit2Artifact.bytecode,
    args: () => ({ ready: true, args: [] }),
  },
  {
    kind: 'deploy',
    key: 'reactor',
    label: '2. Deploy DutchOrderReactor',
    description:
      'UniswapX DutchOrderReactor (verbatim, solc 0.8.29, audited upstream). Constructor takes the Permit2 address and sets the reactor owner (treasury) in one shot. Reactor runs fee-free until setProtocolFeeController is called in step 4.',
    abi: reactorArtifact.abi,
    bytecode: reactorArtifact.bytecode,
    args: ({ treasury, addresses }) => {
      if (!addresses.permit2) return { ready: false, missing: 'Permit2' };
      return { ready: true, args: [addresses.permit2, treasury] };
    },
  },
  {
    kind: 'deploy',
    key: 'feeController',
    label: '3. Deploy EticaProtocolFeeController',
    description:
      'EticaHub ETX-denominated fee controller (ours, 115 LoC, solc 0.8.29). Hard-capped at 100 bps (1%). Deploys fee-off (feeBps = 0); flip on later via /admin/reactor.',
    abi: feeControllerArtifact.abi,
    bytecode: feeControllerArtifact.bytecode,
    args: ({ treasury, etx }) => ({
      ready: true,
      args: [etx, treasury, treasury, 0n],
    }),
  },
  {
    kind: 'call',
    key: 'wireController',
    label: '4. Wire fee controller on reactor',
    description:
      'Calls reactor.setProtocolFeeController(feeController). This is the only step that requires your wallet to be the reactor owner (set in step 2 ctor to the treasury). Until this call lands, the reactor charges zero protocol fee.',
    abi: reactorArtifact.abi,
    functionName: 'setProtocolFeeController',
    target: (addresses) => addresses.reactor ?? null,
    args: ({ addresses }) => {
      if (!addresses.reactor) return { ready: false, missing: 'reactor' };
      if (!addresses.feeController) return { ready: false, missing: 'feeController' };
      return { ready: true, args: [addresses.feeController] };
    },
  },
];

export function DeployTradingCard() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { connectors, connect, status: connectStatus } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();

  const onMainnet = chainId === eticaMainnet.id;
  const defaultEtx = DEPLOYMENTS[eticaMainnet.id].etx as Address;

  const [treasuryInput, setTreasuryInput] = useState<string>(TREASURY_ADDRESS);
  const treasury = useMemo<Address | null>(() => {
    const t = treasuryInput.trim();
    return isAddress(t) ? (t as Address) : null;
  }, [treasuryInput]);

  const [etxInput, setEtxInput] = useState<string>(defaultEtx);
  const etx = useMemo<Address | null>(() => {
    const t = etxInput.trim();
    return isAddress(t) ? (t as Address) : null;
  }, [etxInput]);

  const [state, setState] = useState<Record<StepKey, DeployState>>({
    permit2: initial,
    reactor: initial,
    feeController: initial,
    wireController: initial,
  });

  const addresses: Addresses = useMemo(
    () => ({
      permit2: state.permit2.address,
      reactor: state.reactor.address,
      feeController: state.feeController.address,
    }),
    [state],
  );

  const allDone =
    state.permit2.status === 'confirmed' &&
    state.reactor.status === 'confirmed' &&
    state.feeController.status === 'confirmed' &&
    state.wireController.status === 'confirmed';

  async function runStep(step: StepConfig) {
    if (!walletClient || !publicClient || !address || !treasury || !etx) return;
    const argSpec = step.args({ treasury, etx, addresses });
    if (!argSpec.ready) {
      setState((s) => ({
        ...s,
        [step.key]: { status: 'error', error: `Deploy ${argSpec.missing} first` },
      }));
      return;
    }

    setState((s) => ({ ...s, [step.key]: { status: 'signing' } }));

    let txHash: Hex;
    try {
      if (step.kind === 'deploy') {
        txHash = await walletClient.deployContract({
          abi: step.abi,
          bytecode: step.bytecode,
          args: argSpec.args,
          account: address,
        });
      } else {
        const target = step.target(addresses);
        if (!target) {
          setState((s) => ({
            ...s,
            [step.key]: { status: 'error', error: 'Target contract missing' },
          }));
          return;
        }
        txHash = await walletClient.writeContract({
          address: target,
          abi: step.abi,
          functionName: step.functionName,
          args: argSpec.args,
        });
      }
    } catch (err) {
      setState((s) => ({ ...s, [step.key]: { status: 'error', error: shortError(err) } }));
      return;
    }

    setState((s) => ({ ...s, [step.key]: { status: 'pending', txHash } }));

    try {
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') {
        setState((s) => ({
          ...s,
          [step.key]: { status: 'error', txHash, error: 'Transaction reverted on-chain' },
        }));
        return;
      }
      if (step.kind === 'deploy') {
        if (!receipt.contractAddress) {
          setState((s) => ({
            ...s,
            [step.key]: {
              status: 'error',
              txHash,
              error: 'Deploy succeeded but contractAddress missing from receipt',
            },
          }));
          return;
        }
        setState((s) => ({
          ...s,
          [step.key]: {
            status: 'confirmed',
            txHash,
            address: receipt.contractAddress as Address,
          },
        }));
      } else {
        setState((s) => ({ ...s, [step.key]: { status: 'confirmed', txHash } }));
      }
    } catch (err) {
      setState((s) => ({
        ...s,
        [step.key]: { status: 'error', txHash, error: shortError(err) },
      }));
    }
  }

  const injectedConnector = connectors.find((c) => c.id === 'injected') ?? connectors[0];

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-3 text-lg font-semibold">Prerequisites</h2>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-white/70">
          <li>MetaMask installed and unlocked.</li>
          <li>Connected to Etica Mainnet (chain id 61803). This page can add it for you.</li>
          <li>
            At least <span className="font-mono">~1 EGAZ</span> in the deploying wallet to cover
            gas for all four txs (Permit2 is large, ~9 KB).
          </li>
          <li>
            Treasury address below becomes the reactor owner <em>and</em> the fee controller
            owner. It also becomes the recipient of any future ETX protocol fees. Defaults to the
            project treasury; change it only if you&apos;re deploying under a different operator.
          </li>
          <li>
            For the 4th tx (wire fee controller onto reactor) the connected wallet must be the
            same treasury address — reactor owner is set in step 2&apos;s ctor and only the
            reactor owner can call <span className="font-mono">setProtocolFeeController</span>.
          </li>
        </ol>
      </section>

      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-4 text-lg font-semibold">Wallet</h2>
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
          </div>
        )}
      </section>

      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-3 text-lg font-semibold">Treasury / reactor owner</h2>
        <input
          type="text"
          value={treasuryInput}
          onChange={(e) => setTreasuryInput(e.target.value)}
          spellCheck={false}
          className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm outline-none focus:border-emerald-500"
          placeholder="0x…"
        />
        {!treasury && <div className="mt-2 text-xs text-red-400">Not a valid address.</div>}
      </section>

      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-3 text-lg font-semibold">ETX token address</h2>
        <p className="mb-3 text-xs text-white/60">
          The fee controller charges fees in ETX. Defaults to the mainnet ETX deployed with
          EticaSwap V1. Change only if you&apos;re re-deploying against a new token.
        </p>
        <input
          type="text"
          value={etxInput}
          onChange={(e) => setEtxInput(e.target.value)}
          spellCheck={false}
          className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm outline-none focus:border-emerald-500"
          placeholder="0x…"
        />
        {etxInput.trim().length > 0 && !etx && (
          <div className="mt-2 text-xs text-red-400">Not a valid address.</div>
        )}
      </section>

      <section className="space-y-4">
        {STEPS.map((step) => {
          const s = state[step.key];
          const canRun =
            isConnected && onMainnet && Boolean(treasury) && Boolean(etx) && Boolean(walletClient);
          const argSpec = step.args({
            treasury: treasury ?? TREASURY_ADDRESS,
            etx: etx ?? defaultEtx,
            addresses,
          });
          const blocked = !argSpec.ready;
          const busy = s.status === 'signing' || s.status === 'pending';
          return (
            <div key={step.key} className="rounded-xl border border-white/10 bg-white/5 p-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="font-semibold">{step.label}</h3>
                  <p className="mt-1 text-sm text-white/60">{step.description}</p>
                </div>
                <button
                  onClick={() => runStep(step)}
                  disabled={!canRun || blocked || busy || s.status === 'confirmed'}
                  className="shrink-0 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-black hover:bg-emerald-400 disabled:opacity-40"
                >
                  {s.status === 'confirmed'
                    ? step.kind === 'deploy'
                      ? 'Deployed'
                      : 'Called'
                    : s.status === 'signing'
                      ? 'Confirm in wallet…'
                      : s.status === 'pending'
                        ? 'Mining…'
                        : blocked && argSpec.ready === false
                          ? `Needs ${argSpec.missing}`
                          : step.kind === 'deploy'
                            ? 'Deploy'
                            : 'Call'}
                </button>
              </div>
              {s.txHash && (
                <div className="mt-3 text-xs">
                  <span className="text-white/50">tx:</span>{' '}
                  <a
                    className="font-mono text-emerald-400 hover:underline"
                    href={`https://eticascan.org/tx/${s.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {s.txHash}
                  </a>
                </div>
              )}
              {s.address && (
                <div className="mt-1 text-xs">
                  <span className="text-white/50">address:</span>{' '}
                  <a
                    className="font-mono text-emerald-400 hover:underline"
                    href={`https://eticascan.org/address/${s.address}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {s.address}
                  </a>
                </div>
              )}
              {s.error && (
                <div className="mt-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                  {s.error}
                </div>
              )}
            </div>
          );
        })}
      </section>

      {allDone && (
        <section className="rounded-xl border border-emerald-500/40 bg-emerald-500/5 p-5">
          <h2 className="mb-3 text-lg font-semibold text-emerald-300">
            Trading stack fully deployed
          </h2>
          <p className="mb-3 text-sm text-white/70">
            Copy this block and paste it back into the chat — I&apos;ll wire the addresses into{' '}
            <span className="font-mono">packages/shared/src/addresses.ts</span> in a follow-up PR,
            which drops the beta banner across Limit/Stop/DCA/Grid and turns signing live.
          </p>
          <pre className="overflow-x-auto rounded bg-black/60 p-3 text-xs">
            {`chainId: 61803 (Etica Mainnet)
permit2:          ${addresses.permit2}
dutchReactor:     ${addresses.reactor}
etxFeeController: ${addresses.feeController}
reactor owner / feeController owner / treasury: ${treasury}`}
          </pre>
        </section>
      )}
    </div>
  );
}
