'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
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
import { DEPLOYMENTS, TREASURY_ADDRESS } from '@etica-hub/shared/addresses';
import etxFarmsArtifact from '@/lib/etx-farms-artifact.json';

/**
 * One-shot deployer for the ETXFarms LP staking contract.
 *
 * Constructor takes three arguments:
 *   - rewardToken: ETX address (hard-wired on Etica mainnet).
 *   - fallbackRecipient: receiver of rewards allocated to empty pools
 *     (defaults to the EticaHub treasury).
 *   - owner: initial owner — defaults to the deploying account, rotatable
 *     to the treasury multisig after deploy.
 *
 * After deploy, the operator must (in this order):
 *   1. Paste the deployed address into `packages/shared/src/addresses.ts`
 *      under `DEPLOYMENTS[61803].etxFarms`.
 *   2. Call `ETXFarms.addPool(ETI/ETX LP, 5000)` and
 *      `ETXFarms.addPool(EGAZ/ETX LP, 5000)` — from the owner wallet — to
 *      register the two launch pools with equal weight.
 *   3. Call `TreasuryHarvester.setFarms(etxFarms)` so the 10% farms slice
 *      flows through on every harvest.
 *   4. (Optional) Transfer ownership to the treasury multisig via
 *      `Ownable2Step.transferOwnership`.
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

export function DeployETXFarmsCard() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { connectors, connect, status: connectStatus } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();

  const onMainnet = chainId === eticaMainnet.id;
  const defaultEtx = onMainnet ? DEPLOYMENTS[eticaMainnet.id].etx : ZERO_ADDRESS;
  const defaultFallback = TREASURY_ADDRESS;

  const [etxInput, setEtxInput] = useState<string>(defaultEtx);
  const [fallbackInput, setFallbackInput] = useState<string>(defaultFallback);
  const etxEditedRef = useRef(false);
  const fallbackEditedRef = useRef(false);
  const [state, setState] = useState<DeployState>({ status: 'idle' });

  useEffect(() => {
    if (!etxEditedRef.current) setEtxInput(defaultEtx);
  }, [defaultEtx]);

  const parsedEtx = useMemo<Address | null>(() => {
    try {
      const a = getAddress(etxInput.trim());
      return a === ZERO_ADDRESS ? null : a;
    } catch {
      return null;
    }
  }, [etxInput]);

  const parsedFallback = useMemo<Address | null>(() => {
    try {
      const a = getAddress(fallbackInput.trim());
      return a === ZERO_ADDRESS ? null : a;
    } catch {
      return null;
    }
  }, [fallbackInput]);

  async function onDeploy() {
    if (!walletClient || !publicClient || !address || !parsedEtx || !parsedFallback) return;
    setState({ status: 'signing' });

    let txHash: Hex;
    try {
      const data = encodeDeployData({
        abi: etxFarmsArtifact.abi,
        bytecode: etxFarmsArtifact.bytecode as Hex,
        // rewardToken, fallbackRecipient, owner (= deployer)
        args: [parsedEtx, parsedFallback, address],
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
          A MasterChef-style LP staking contract named{' '}
          <span className="font-mono">ETXFarms</span>. Users stake ETI/ETX or EGAZ/ETX LP
          tokens; the TreasuryHarvester calls{' '}
          <span className="font-mono">distributeRewards(amount)</span> on each harvest cycle,
          splitting the 10% farms slice pro-rata across staked LP positions.
        </p>
        <p className="mt-2 text-sm text-white/70">
          Compiled with <span className="font-mono">{etxFarmsArtifact.version}</span>.{' '}
          <span className="font-mono">owner()</span> controls pool allocation only — it cannot
          pause the contract, rescue ETX (belongs to stakers pro-rata), or rescue any
          registered LP token. Reward injection is permissionless; any address can top up.
        </p>
      </section>

      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-3 text-lg font-semibold">Key properties</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-white/70">
          <li>
            No emissions. The contract only distributes ETX explicitly pushed in via{' '}
            <span className="font-mono">distributeRewards</span> — zero new supply is minted.
          </li>
          <li>
            Classic <span className="font-mono">accRewardPerShare</span> accumulator math.
            Late joiners cannot back-claim past rewards.
          </li>
          <li>
            Pools with zero staked LP at distribution time forward their share to the
            fallback recipient (treasury) rather than sitting idle.
          </li>
          <li>
            No deposit fee, no withdraw fee, no lockup. Users can{' '}
            <span className="font-mono">emergencyWithdraw</span> at any time, forfeiting
            pending rewards.
          </li>
        </ul>
      </section>

      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-4 text-lg font-semibold">Constructor</h2>
        <label className="block text-sm text-white/70">
          Reward token (ETX) address
          <input
            type="text"
            className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-white placeholder:text-white/30"
            value={etxInput}
            onChange={(e) => {
              etxEditedRef.current = true;
              setEtxInput(e.target.value);
            }}
            placeholder="0x…"
            spellCheck={false}
          />
        </label>
        <label className="mt-4 block text-sm text-white/70">
          Fallback recipient (defaults to treasury)
          <input
            type="text"
            className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-white placeholder:text-white/30"
            value={fallbackInput}
            onChange={(e) => {
              fallbackEditedRef.current = true;
              setFallbackInput(e.target.value);
            }}
            placeholder="0x…"
            spellCheck={false}
          />
        </label>
        <p className="mt-2 text-xs text-white/50">
          Owner is set to your connected wallet (<span className="font-mono">{address ?? '—'}</span>
          ). Transfer ownership to the treasury multisig via{' '}
          <span className="font-mono">Ownable2Step.transferOwnership</span> after deploy.
        </p>
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
        <h2 className="mb-4 text-lg font-semibold">Deploy ETXFarms</h2>
        <button
          type="button"
          className="rounded-md bg-emerald-500/90 px-4 py-2 text-sm font-medium text-black transition hover:bg-emerald-400 disabled:opacity-40"
          onClick={onDeploy}
          disabled={
            !isConnected ||
            !walletClient ||
            !parsedEtx ||
            !parsedFallback ||
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
                : 'Deploy ETXFarms'}
        </button>
        {(!parsedEtx || !parsedFallback) && (
          <p className="mt-2 text-xs text-amber-300/80">
            Both the ETX and fallback-recipient addresses must be valid to enable the deploy
            button.
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
              ETXFarms deployed at{' '}
              <span className="font-mono break-all">{state.address}</span>
            </p>
            <div className="mt-2 space-y-1 text-emerald-200/80">
              <p>Next steps, in order:</p>
              <ol className="list-decimal space-y-1 pl-5">
                <li>
                  Paste the address into{' '}
                  <span className="font-mono">packages/shared/src/addresses.ts</span> under{' '}
                  <span className="font-mono">DEPLOYMENTS[{chainId}].etxFarms</span>.
                </li>
                <li>
                  From the owner wallet, call{' '}
                  <span className="font-mono">addPool(ETI/ETX LP, 5000)</span> and{' '}
                  <span className="font-mono">addPool(EGAZ/ETX LP, 5000)</span> to register the
                  two launch pools at 50/50 weight.
                </li>
                <li>
                  From the treasury multisig, call{' '}
                  <span className="font-mono">TreasuryHarvester.setFarms(address)</span> so the
                  10% farms slice flows through on every harvest.
                </li>
                <li>
                  (Optional) Rotate ownership to the treasury multisig via{' '}
                  <span className="font-mono">transferOwnership</span>.
                </li>
              </ol>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
