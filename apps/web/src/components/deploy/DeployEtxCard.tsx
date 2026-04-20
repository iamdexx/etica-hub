'use client';

import { useMemo, useState } from 'react';
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
import { eticaMainnet } from '@etica-hub/shared/chains';
import { etxArtifact } from '@/lib/deploy-artifacts';

const DEFAULT_DISTRIBUTOR: Address = '0xB2B4bC9d02970A55efF64C2D84c622c87967C19D';

type DeployState = {
  status: 'idle' | 'signing' | 'pending' | 'confirmed' | 'error';
  txHash?: Hex;
  address?: Address;
  error?: string;
};

function shortError(err: unknown): string {
  if (err instanceof UserRejectedRequestError) return 'Rejected in wallet.';
  if (err instanceof BaseError) return err.shortMessage ?? err.message;
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

export function DeployEtxCard() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { connectors, connect, status: connectStatus } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();

  const onMainnet = chainId === eticaMainnet.id;

  const [distributorInput, setDistributorInput] = useState<string>(DEFAULT_DISTRIBUTOR);
  const distributor = useMemo<Address | null>(() => {
    const t = distributorInput.trim();
    return isAddress(t) ? (t as Address) : null;
  }, [distributorInput]);

  const [state, setState] = useState<DeployState>({ status: 'idle' });

  async function runDeploy() {
    if (!walletClient || !publicClient || !address || !distributor) return;
    setState({ status: 'signing' });

    let txHash: Hex;
    try {
      txHash = await walletClient.deployContract({
        abi: etxArtifact.abi,
        bytecode: etxArtifact.bytecode,
        args: [distributor],
        account: address,
      });
    } catch (err) {
      setState({ status: 'error', error: shortError(err) });
      return;
    }

    setState({ status: 'pending', txHash });
    try {
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success' || !receipt.contractAddress) {
        setState({ status: 'error', txHash, error: 'Transaction reverted on-chain' });
        return;
      }
      setState({
        status: 'confirmed',
        txHash,
        address: receipt.contractAddress as Address,
      });
    } catch (err) {
      setState({ status: 'error', txHash, error: shortError(err) });
    }
  }

  const injectedConnector = connectors.find((c) => c.id === 'injected') ?? connectors[0];
  const canRun = isConnected && onMainnet && Boolean(distributor) && Boolean(walletClient);
  const busy = state.status === 'signing' || state.status === 'pending';

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-3 text-lg font-semibold">What this deploys</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-white/70">
          <li>
            <span className="font-mono">ETXToken</span> — ERC20Permit with fixed supply of{' '}
            <span className="font-mono">100,000,000 ETX</span>. Supply is minted once in the
            constructor and cannot be increased.
          </li>
          <li>
            All <span className="font-mono">100M ETX</span> is minted to the{' '}
            <span className="font-mono">distributor</span> address below. That address is the
            recipient — not the deployer. They can be the same wallet.
          </li>
          <li>
            No proxy, no owner, no pause. The token contract has no privileged functions after
            deploy.
          </li>
        </ul>
      </section>

      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-3 text-lg font-semibold">Prerequisites</h2>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-white/70">
          <li>MetaMask installed and unlocked.</li>
          <li>Connected to Etica Mainnet (chain id 61803). This page can add it for you.</li>
          <li>
            At least <span className="font-mono">~0.03 EGAZ</span> in the deploying wallet for
            gas.
          </li>
          <li>
            Distributor address below will receive the full 100M supply. Defaults to the project
            treasury.
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
            <div className="font-mono text-white/80 break-all">{address}</div>
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
        <h2 className="mb-3 text-lg font-semibold">Distributor (supply recipient)</h2>
        <input
          type="text"
          value={distributorInput}
          onChange={(e) => setDistributorInput(e.target.value)}
          spellCheck={false}
          className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm outline-none focus:border-emerald-500"
          placeholder="0x…"
        />
        {!distributor && (
          <div className="mt-2 text-xs text-red-400">Not a valid address.</div>
        )}
        <p className="mt-2 text-xs text-white/50">
          This address receives the full 100,000,000 ETX supply. You cannot change it after
          deploy.
        </p>
      </section>

      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="font-semibold">Deploy ETXToken</h3>
            <p className="mt-1 text-sm text-white/60">
              One-shot. MetaMask will pop up; confirm in your wallet.
            </p>
          </div>
          <button
            onClick={runDeploy}
            disabled={!canRun || busy || state.status === 'confirmed'}
            className="shrink-0 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-black hover:bg-emerald-400 disabled:opacity-40"
          >
            {state.status === 'confirmed'
              ? 'Deployed'
              : state.status === 'signing'
                ? 'Confirm in wallet…'
                : state.status === 'pending'
                  ? 'Confirming…'
                  : 'Deploy ETX'}
          </button>
        </div>

        {state.status === 'error' && state.error && (
          <div className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {state.error}
          </div>
        )}
        {state.txHash && (
          <div className="mt-3 text-xs text-white/60">
            Tx:{' '}
            <a
              href={`https://eticascan.org/tx/${state.txHash}`}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-emerald-400 hover:underline"
            >
              {state.txHash}
            </a>
          </div>
        )}
        {state.address && (
          <div className="mt-1 text-xs text-white/60">
            ETX address:{' '}
            <span className="font-mono text-emerald-400">{state.address}</span>
          </div>
        )}
      </section>

      {state.status === 'confirmed' && state.address && (
        <section className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-5 text-sm">
          <h3 className="mb-2 font-semibold text-emerald-300">Next step</h3>
          <p className="text-white/80">
            ETX is live. Save the address above, then head to{' '}
            <a href="/seed/pools" className="text-emerald-400 underline hover:no-underline">
              /seed/pools
            </a>{' '}
            to open the ETI/ETX and EGAZ/ETX pools with initial liquidity.
          </p>
        </section>
      )}
    </div>
  );
}
