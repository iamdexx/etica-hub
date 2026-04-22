'use client';

import { useMemo, useState } from 'react';
import {
  BaseError,
  UserRejectedRequestError,
  encodeDeployData,
  getAddress,
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
import { DEPLOYMENTS } from '@etica-hub/shared/addresses';
import stakedEtxArtifact from '@/lib/staked-etx-artifact.json';

/**
 * One-shot deployer for the stETX ERC-4626 vault.
 *
 * Constructor takes a single argument: the ERC-20 address of the underlying
 * asset (ETX). On Etica mainnet the ETX address is hard-wired from shared
 * addresses; on any other chain the operator must paste it in manually.
 *
 * No ownership, no admin keys, no upgradability. Once deployed, the vault
 * is immutable: anyone can deposit/withdraw, anyone can call
 * {distributeRewards}. The operator's only remaining job is to paste the
 * deployed address back into packages/shared/src/addresses.ts so the
 * frontend can find it.
 */

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

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

export function DeployStakedETXCard() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { connectors, connect, status: connectStatus } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();

  const onMainnet = chainId === eticaMainnet.id;
  const defaultEtx = onMainnet ? DEPLOYMENTS[eticaMainnet.id].etx : ZERO_ADDRESS;

  const [etxInput, setEtxInput] = useState<string>(defaultEtx);
  const [state, setState] = useState<DeployState>({ status: 'idle' });

  const parsedEtx = useMemo<Address | null>(() => {
    try {
      const a = getAddress(etxInput.trim());
      if (a === ZERO_ADDRESS) return null;
      return a;
    } catch {
      return null;
    }
  }, [etxInput]);

  async function onDeploy() {
    if (!walletClient || !publicClient || !address || !parsedEtx) return;
    setState({ status: 'signing' });

    let txHash: Hex;
    try {
      const data = encodeDeployData({
        abi: stakedEtxArtifact.abi,
        bytecode: stakedEtxArtifact.bytecode as Hex,
        args: [parsedEtx],
      });
      txHash = await walletClient.sendTransaction({
        account: address,
        data,
      });
    } catch (err) {
      setState({ status: 'error', error: shortError(err) });
      return;
    }
    setState({ status: 'pending', txHash });

    try {
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') {
        setState({ status: 'error', txHash, error: 'Transaction reverted on-chain' });
        return;
      }
      if (!receipt.contractAddress) {
        setState({
          status: 'error',
          txHash,
          error: 'Deploy succeeded but contractAddress missing from receipt',
        });
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

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-3 text-lg font-semibold">What this deploys</h2>
        <p className="text-sm text-white/70">
          An ERC-4626 vault named <span className="font-mono">Staked ETX (stETX)</span>. Users
          deposit ETX and mint stETX shares at the current exchange rate. The keeper periodically
          calls <span className="font-mono">distributeRewards()</span> to inject harvested ETX into
          the vault, which grows <span className="font-mono">totalAssets</span> without changing
          share supply &mdash; i.e., every existing stETX becomes redeemable for slightly more ETX.
        </p>
        <p className="mt-2 text-sm text-white/70">
          Compiled with <span className="font-mono">{stakedEtxArtifact.version}</span>. No owner,
          no admin functions, no upgrade path. Once deployed, the contract is fully permissionless.
        </p>
      </section>

      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-3 text-lg font-semibold">Key properties</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-white/70">
          <li>
            Exchange rate <span className="font-mono">stETX &rarr; ETX</span> is monotonically
            non-decreasing. The only outflows are withdraw/redeem, which burn shares pro-rata.
          </li>
          <li>
            <span className="font-mono">MIN_DEPOSIT = 1 ETX</span> on every deposit/mint path,
            plus OpenZeppelin v5 virtual-share offset, blocks share-inflation attacks.
          </li>
          <li>
            stETX itself is a plain ERC-20 with EIP-2612 permit &mdash; listable on our own AMM,
            usable as collateral in future lending markets, freely transferable.
          </li>
          <li>No lockup, no withdrawal delay, no slashing.</li>
        </ul>
      </section>

      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-4 text-lg font-semibold">Constructor</h2>
        <label className="block text-sm text-white/70">
          Underlying asset (ETX) address
          <input
            type="text"
            className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-white placeholder:text-white/30"
            value={etxInput}
            onChange={(e) => setEtxInput(e.target.value)}
            placeholder="0x…"
            spellCheck={false}
          />
        </label>
        {onMainnet ? (
          <p className="mt-2 text-xs text-white/50">
            Pre-filled with the canonical ETX address from{' '}
            <span className="font-mono">packages/shared/src/addresses.ts</span>. Edit only if
            you&apos;re deploying a test instance.
          </p>
        ) : (
          <p className="mt-2 text-xs text-amber-300/80">
            Not on Etica mainnet &mdash; paste the ETX address of the chain you&apos;re on.
          </p>
        )}
      </section>

      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-4 text-lg font-semibold">Wallet</h2>
        {!isConnected ? (
          <button
            type="button"
            className="rounded-md bg-emerald-500/90 px-4 py-2 text-sm font-medium text-black transition hover:bg-emerald-400 disabled:opacity-40"
            onClick={() => injectedConnector && connect({ connector: injectedConnector })}
            disabled={connectStatus === 'pending' || !injectedConnector}
          >
            {connectStatus === 'pending' ? 'Connecting…' : 'Connect Wallet'}
          </button>
        ) : (
          <div className="space-y-3 text-sm">
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
        <h2 className="mb-4 text-lg font-semibold">Deploy stETX</h2>
        <button
          type="button"
          className="rounded-md bg-emerald-500/90 px-4 py-2 text-sm font-medium text-black transition hover:bg-emerald-400 disabled:opacity-40"
          onClick={onDeploy}
          disabled={
            !isConnected ||
            !walletClient ||
            !parsedEtx ||
            state.status === 'signing' ||
            state.status === 'pending' ||
            state.status === 'confirmed'
          }
        >
          {state.status === 'signing'
            ? 'Sign in wallet…'
            : state.status === 'pending'
              ? 'Waiting for confirmation…'
              : state.status === 'confirmed'
                ? 'Deployed'
                : 'Deploy stETX'}
        </button>
        {!parsedEtx && (
          <p className="mt-2 text-xs text-amber-300/80">
            Enter a valid ETX address to enable the deploy button.
          </p>
        )}
        {state.status === 'error' && state.error && (
          <p className="mt-3 rounded-md border border-rose-400/30 bg-rose-500/10 p-3 text-sm text-rose-200">
            {state.error}
          </p>
        )}
        {state.txHash && (
          <p className="mt-3 text-xs text-white/60">
            Tx: <span className="font-mono break-all">{state.txHash}</span>
          </p>
        )}
        {state.status === 'confirmed' && state.address && (
          <div className="mt-4 rounded-md border border-emerald-400/30 bg-emerald-500/10 p-3 text-sm">
            <p className="font-medium text-emerald-200">
              stETX deployed at <span className="font-mono break-all">{state.address}</span>
            </p>
            <p className="mt-1 text-emerald-200/80">
              Paste that address into{' '}
              <span className="font-mono">packages/shared/src/addresses.ts</span> under{' '}
              <span className="font-mono">DEPLOYMENTS[{chainId}].stakedETX</span>, commit, and
              redeploy the web app. The <span className="font-mono">/stake</span> page (PR #83)
              will pick it up automatically.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
