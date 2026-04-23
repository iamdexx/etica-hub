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
import treasuryHarvesterArtifact from '@/lib/treasury-harvester-artifact.json';

/**
 * One-shot deployer for the TreasuryHarvester delegation contract.
 *
 * Constructor takes four arguments:
 *   - owner: treasury multisig (sole admin post-deploy — sets keeper, split,
 *     reward sinks, safety caps).
 *   - etx: ETX token address (the hub asset of every pair this contract
 *     harvests).
 *   - factory: EticaSwap factory — used to validate pair registration.
 *   - keeper: hot EOA that will fire `harvest(pools)` on schedule. Separate
 *     from the treasury multisig so live txs never require a multisig round.
 *
 * Defaults baked into the constructor:
 *   - Split 10 / 10 / 40 / 40 bps (stETX / farms / POL-burn / treasury).
 *   - {maxBurnBpsPerRun} = 100 (1% of treasury LP per harvest run).
 *
 * After deploy, the treasury multisig must (in this order):
 *   1. Paste the deployed address into `packages/shared/src/addresses.ts`
 *      under `DEPLOYMENTS[61803].treasuryHarvester`.
 *   2. `harvester.setStakedEtx(stakedETX)` — routes the 10% stETX slice to
 *      the staking vault so stakers earn the vault-level yield.
 *   3. `harvester.setFarms(etxFarms)` — routes the 10% farms slice to the
 *      LP staking contract so LPs earn pro-rata.
 *   4. Approve the harvester to pull LP from the treasury on each ETX pair:
 *      `IERC20(stETX/ETX LP).approve(harvester, type(uint256).max)` and the
 *      same for EGAZ/ETX and ETI/ETX LP tokens.
 *   5. Fund the hot keeper EOA with ~100 EGAZ (overprovisioned per the
 *      runbook) and flip `HARVESTER_LIVE=true` in the GitHub Actions env to
 *      enable the live harvest cron.
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

export function DeployHarvesterCard() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { connectors, connect, status: connectStatus } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();

  const onMainnet = chainId === eticaMainnet.id;
  const defaultEtx = onMainnet ? DEPLOYMENTS[eticaMainnet.id].etx : ZERO_ADDRESS;
  const defaultFactory = onMainnet ? DEPLOYMENTS[eticaMainnet.id].swapFactory : ZERO_ADDRESS;
  const defaultOwner = TREASURY_ADDRESS;

  const [ownerInput, setOwnerInput] = useState<string>(defaultOwner);
  const [etxInput, setEtxInput] = useState<string>(defaultEtx);
  const [factoryInput, setFactoryInput] = useState<string>(defaultFactory);
  const [keeperInput, setKeeperInput] = useState<string>('');
  const ownerEditedRef = useRef(false);
  const etxEditedRef = useRef(false);
  const factoryEditedRef = useRef(false);
  const [state, setState] = useState<DeployState>({ status: 'idle' });

  useEffect(() => {
    if (!etxEditedRef.current) setEtxInput(defaultEtx);
  }, [defaultEtx]);
  useEffect(() => {
    if (!factoryEditedRef.current) setFactoryInput(defaultFactory);
  }, [defaultFactory]);
  useEffect(() => {
    if (!ownerEditedRef.current) setOwnerInput(defaultOwner);
  }, [defaultOwner]);

  const parsedOwner = useMemo<Address | null>(() => {
    try {
      const a = getAddress(ownerInput.trim());
      return a === ZERO_ADDRESS ? null : a;
    } catch {
      return null;
    }
  }, [ownerInput]);

  const parsedEtx = useMemo<Address | null>(() => {
    try {
      const a = getAddress(etxInput.trim());
      return a === ZERO_ADDRESS ? null : a;
    } catch {
      return null;
    }
  }, [etxInput]);

  const parsedFactory = useMemo<Address | null>(() => {
    try {
      const a = getAddress(factoryInput.trim());
      return a === ZERO_ADDRESS ? null : a;
    } catch {
      return null;
    }
  }, [factoryInput]);

  const parsedKeeper = useMemo<Address | null>(() => {
    try {
      const a = getAddress(keeperInput.trim());
      return a === ZERO_ADDRESS ? null : a;
    } catch {
      return null;
    }
  }, [keeperInput]);

  const keeperEqualsTreasury =
    parsedKeeper !== null && parsedOwner !== null && parsedKeeper === parsedOwner;

  async function onDeploy() {
    if (
      !walletClient ||
      !publicClient ||
      !address ||
      !parsedOwner ||
      !parsedEtx ||
      !parsedFactory ||
      !parsedKeeper
    ) {
      return;
    }
    setState({ status: 'signing' });

    let txHash: Hex;
    try {
      const data = encodeDeployData({
        abi: treasuryHarvesterArtifact.abi,
        bytecode: treasuryHarvesterArtifact.bytecode as Hex,
        // owner, etx, factory, keeper
        args: [parsedOwner, parsedEtx, parsedFactory, parsedKeeper],
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
          The <span className="font-mono">TreasuryHarvester</span> delegation contract — a thin
          on-chain pipeline that lets a limited-funds hot keeper wallet run the daily fee-harvest
          cycle without ever touching the treasury multisig. The keeper pulls a capped slice of
          treasury LP on each ETX pair, burns it, swaps the non-ETX leg back to ETX, then splits the
          harvested ETX into four slices per BPS: stETX rewards, farms rewards, POL-burn (permanent
          depth), and treasury retained.
        </p>
        <p className="mt-2 text-sm text-white/70">
          Compiled with <span className="font-mono">{treasuryHarvesterArtifact.version}</span>.
          Default split is <span className="font-mono">10 / 10 / 40 / 40</span> (stETX / farms /
          POL-burn / treasury) and <span className="font-mono">maxBurnBpsPerRun = 100</span> (1% of
          treasury LP per run). Both are owner-tunable post-deploy without redeploying the contract.
        </p>
      </section>

      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-3 text-lg font-semibold">Key properties</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-white/70">
          <li>
            The contract holds <span className="font-mono">approvals</span>, not balances. The
            treasury multisig retains custody of all LP tokens; the harvester only pulls the capped
            slice at the moment of each run.
          </li>
          <li>
            <span className="font-mono">harvest(pools)</span> is{' '}
            <span className="font-mono">onlyKeeper</span>. If the hot keeper key leaks, the attacker
            can at most burn <span className="font-mono">maxBurnBpsPerRun</span> of treasury LP per
            run with adversarial slippage — bounded blast radius, no direct drain.
          </li>
          <li>
            All harvested ETX must be fully accounted for each run. Split slices that can&apos;t be
            forwarded (stETX / farms unset) fall through to the treasury retained slice — nothing
            stays stuck on the contract.
          </li>
          <li>
            Zero native EGAZ touches the contract. The keeper EOA funds its own gas; the harvester
            pipeline is ERC-20-only.
          </li>
        </ul>
      </section>

      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-4 text-lg font-semibold">Constructor</h2>
        <label className="block text-sm text-white/70">
          Owner (treasury multisig)
          <input
            type="text"
            className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-white placeholder:text-white/30"
            value={ownerInput}
            onChange={(e) => {
              ownerEditedRef.current = true;
              setOwnerInput(e.target.value);
            }}
            placeholder="0x…"
            spellCheck={false}
          />
        </label>
        <p className="mt-1 text-xs text-white/50">
          Defaults to the EticaHub treasury multisig. Owner is the only address that can rotate the
          keeper, change the split, adjust the safety caps, set reward sinks, or rescue mis-sent
          tokens. Use <span className="font-mono">Ownable2Step.transferOwnership</span> (two-step)
          if you need to rotate after deploy.
        </p>

        <label className="mt-4 block text-sm text-white/70">
          ETX token address
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
        <p className="mt-1 text-xs text-white/50">
          The hub asset of every pair harvested by this contract. Must match the ETX token actually
          paired in the factory.
        </p>

        <label className="mt-4 block text-sm text-white/70">
          EticaSwap factory address
          <input
            type="text"
            className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-white placeholder:text-white/30"
            value={factoryInput}
            onChange={(e) => {
              factoryEditedRef.current = true;
              setFactoryInput(e.target.value);
            }}
            placeholder="0x…"
            spellCheck={false}
          />
        </label>
        <p className="mt-1 text-xs text-white/50">
          Used at harvest time to validate that every pair passed in is a real factory-registered{' '}
          <span className="font-mono">(etx, nonEtx)</span> pair.
        </p>

        <label className="mt-4 block text-sm text-white/70">
          Hot keeper EOA
          <input
            type="text"
            className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-white placeholder:text-white/30"
            value={keeperInput}
            onChange={(e) => setKeeperInput(e.target.value)}
            placeholder="0x…  (separate EOA — not the treasury multisig)"
            spellCheck={false}
          />
        </label>
        <p className="mt-1 text-xs text-white/50">
          The EOA that will call <span className="font-mono">harvest(pools)</span> on schedule
          (typically from the <span className="font-mono">harvest-live.yml</span> GitHub Actions
          cron). Must be a dedicated address the keeper workflow controls — see{' '}
          <span className="font-mono">docs/HARVESTER_EGAZ_RUNBOOK.md</span>. If you haven&apos;t
          generated one yet: run <span className="font-mono">cast wallet new</span>, MetaMask&apos;s
          &quot;Add account&quot;, or any fresh burner; save the private key in your password
          manager; paste the public address here.
        </p>
        {keeperEqualsTreasury && (
          <p className="mt-2 rounded-md border border-amber-400/30 bg-amber-500/10 p-2 text-xs text-amber-200">
            Warning: the keeper address equals the treasury/owner address. That defeats the
            split-key design — every harvest would require a full multisig coordination round. Use a
            dedicated hot EOA instead.
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
        <h2 className="mb-4 text-lg font-semibold">Deploy TreasuryHarvester</h2>
        <button
          type="button"
          className="rounded-md bg-emerald-500/90 px-4 py-2 text-sm font-medium text-black transition hover:bg-emerald-400 disabled:opacity-40"
          onClick={onDeploy}
          disabled={
            !isConnected ||
            !walletClient ||
            !parsedOwner ||
            !parsedEtx ||
            !parsedFactory ||
            !parsedKeeper ||
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
                : 'Deploy TreasuryHarvester'}
        </button>
        {(!parsedOwner || !parsedEtx || !parsedFactory || !parsedKeeper) && (
          <p className="mt-2 text-xs text-amber-300/80">
            All four constructor addresses must be valid to enable the deploy button.
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
              TreasuryHarvester deployed at{' '}
              <span className="font-mono break-all">{state.address}</span>
            </p>
            <div className="mt-2 space-y-1 text-emerald-200/80">
              <p>Next steps, in order:</p>
              <ol className="list-decimal space-y-1 pl-5">
                <li>
                  Paste the address into{' '}
                  <span className="font-mono">packages/shared/src/addresses.ts</span> under{' '}
                  <span className="font-mono">DEPLOYMENTS[{chainId}].treasuryHarvester</span>.
                </li>
                <li>
                  From the treasury multisig, call{' '}
                  <span className="font-mono">harvester.setStakedEtx(stakedETX)</span> so the 10%
                  stETX slice flows into the staking vault on every harvest.
                </li>
                <li>
                  From the treasury multisig, call{' '}
                  <span className="font-mono">harvester.setFarms(etxFarms)</span> so the 10% farms
                  slice flows into <span className="font-mono">ETXFarms</span> and is split pro-rata
                  across staked LP positions.
                </li>
                <li>
                  From the treasury multisig, approve the harvester to pull LP on each ETX pair:{' '}
                  <span className="font-mono">
                    IERC20(LP).approve(harvester, type(uint256).max)
                  </span>{' '}
                  for stETX/ETX, EGAZ/ETX, and ETI/ETX LP tokens. The{' '}
                  <span className="font-mono">maxBurnBpsPerRun</span> cap (1%) bounds per-tx damage
                  even with infinite allowance.
                </li>
                <li>
                  Fund the hot keeper EOA with ~100 EGAZ (per the runbook — steady state is ~0.001
                  EGAZ/day, this is deliberately overprovisioned to absorb gas spikes without
                  stranding a cycle).
                </li>
                <li>
                  Set <span className="font-mono">HARVESTER_LIVE=true</span> in the GitHub Actions
                  repo env, and add <span className="font-mono">HARVEST_KEEPER_PRIVATE_KEY</span> as
                  a repo secret if not already present. This activates the daily live harvest cron
                  in <span className="font-mono">.github/workflows/harvest-live.yml</span>.
                </li>
              </ol>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
