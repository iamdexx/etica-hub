'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BaseError,
  UserRejectedRequestError,
  encodeDeployData,
  getAddress,
  parseEther,
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
import eticaResearchMarketsArtifact from '@/lib/etica-research-markets-artifact.json';

/**
 * One-shot deployer for {@link EticaResearchMarkets} — the singleton
 * "V4-style" router that holds the shared 5M ETX research pool and is the
 * sole mint/burn authority for every {@link ResearchToken} it launches.
 *
 * Constructor takes a single struct:
 *   - etx: ETX token address (the unique settlement asset).
 *   - treasury: protocol treasury multisig (receives the treasury fee slice;
 *     defaulted to 0% under the C-with-lock split).
 *   - etiLpSink: ETI POL-burn sink (receives the 10% fee slice; mirrors the
 *     TreasuryHarvester sink pattern — deepens ETI/ETX liquidity).
 *   - owner: contract owner (post-deploy admin — sets fee rate, fee split,
 *     graduation threshold, sunset window, default virtual reserves,
 *     launch toll).
 *   - launchTollEtx: ETX paid by the researcher at launch time
 *     (default: 100 ETX, routed to the shared pool — not a trade fee).
 *   - feeRateBps: trade fee in basis points (default: 100 = 1%, cap 500).
 *   - etiLpBps / treasuryBps / researcherBps: trade fee split in bps; the
 *     remainder (after these three) compounds the shared pool and is
 *     permanently locked POL (never withdrawable). Default
 *     1000 / 0 / 1000 → pool gets 80% — the "C-with-lock" split that
 *     pulls every market's floor up monotonically with use.
 *   - graduationThreshold: ETX reserve in a market that triggers the
 *     UI-only Graduated flag (default 100k ETX).
 *   - sunsetWindow: seconds of no-trade after which a market may be flagged
 *     Sunset (default 30 days; min 7 days).
 *   - defaultVirtualEtxStart / defaultVirtualTokenStart: per-market virtual
 *     reserve defaults used to seed each new launch's bonding curve.
 *
 * After deploy, the treasury multisig must (in order):
 *   1. Paste the deployed singleton address into
 *      `packages/shared/src/addresses.ts` under
 *      `DEPLOYMENTS[61803].eticaResearchMarkets`.
 *   2. Transfer the 5M ETX seed into the singleton:
 *      `IERC20(etx).transfer(eticaResearchMarkets, 5_000_000e18)` — this
 *      is the pool that backs every research-token bonding curve.
 *   3. (Optional) Re-tune the fee rate / split / graduation threshold via
 *      the owner-gated setters before any research token launches.
 *
 * No private key ever leaves the browser. Run once per chain. The
 * deployed contract is bytecode-deterministic so every future
 * {@link ResearchToken} it deploys is verifiable against a single canonical
 * Sourcify metadata bundle (zero-cost auto-verification).
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

// Defaults baked into the deployer UI. All are owner-tunable post-deploy
// via the owner-gated setters on the singleton — no redeploy required.
const DEFAULT_LAUNCH_TOLL_ETX = '100';
const DEFAULT_FEE_RATE_BPS = 100; // 1%
const DEFAULT_ETI_LP_BPS = 1000; // 10%
const DEFAULT_TREASURY_BPS = 0; // 0% (C-with-lock: all value stays on-chain)
const DEFAULT_RESEARCHER_BPS = 1000; // 10%
// Pool slice = BPS - etiLp - treasury - researcher = 10000 - 2000 = 8000 (80%).
// This residual is the permanently locked POL that pulls every market's
// floor up monotonically with use — it is never withdrawable.
const DEFAULT_GRADUATION_THRESHOLD_ETX = '100000';
const DEFAULT_SUNSET_WINDOW_SECONDS = 30 * 24 * 60 * 60; // 30 days
const DEFAULT_VIRTUAL_ETX_START = '5000';
const DEFAULT_VIRTUAL_TOKEN_START = '1000000000';

export function DeployResearchMarketsCard() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { connectors, connect, status: connectStatus } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();

  const onMainnet = chainId === eticaMainnet.id;
  const defaultEtx = onMainnet ? DEPLOYMENTS[eticaMainnet.id].etx : ZERO_ADDRESS;
  const defaultTreasury = TREASURY_ADDRESS;
  // The ETI LP sink defaults to the treasury until a dedicated sink contract
  // is deployed. The treasury can rotate this via setEtiLpSink at any time.
  const defaultEtiLpSink = TREASURY_ADDRESS;
  const defaultOwner = TREASURY_ADDRESS;

  const [etxInput, setEtxInput] = useState<string>(defaultEtx);
  const [treasuryInput, setTreasuryInput] = useState<string>(defaultTreasury);
  const [etiLpSinkInput, setEtiLpSinkInput] = useState<string>(defaultEtiLpSink);
  const [ownerInput, setOwnerInput] = useState<string>(defaultOwner);

  const [launchTollInput, setLaunchTollInput] = useState<string>(DEFAULT_LAUNCH_TOLL_ETX);
  const [feeRateBpsInput, setFeeRateBpsInput] = useState<string>(String(DEFAULT_FEE_RATE_BPS));
  const [etiLpBpsInput, setEtiLpBpsInput] = useState<string>(String(DEFAULT_ETI_LP_BPS));
  const [treasuryBpsInput, setTreasuryBpsInput] = useState<string>(String(DEFAULT_TREASURY_BPS));
  const [researcherBpsInput, setResearcherBpsInput] = useState<string>(
    String(DEFAULT_RESEARCHER_BPS),
  );
  const [graduationThresholdInput, setGraduationThresholdInput] = useState<string>(
    DEFAULT_GRADUATION_THRESHOLD_ETX,
  );
  const [sunsetWindowInput, setSunsetWindowInput] = useState<string>(
    String(DEFAULT_SUNSET_WINDOW_SECONDS),
  );
  const [vEtxStartInput, setVEtxStartInput] = useState<string>(DEFAULT_VIRTUAL_ETX_START);
  const [vTokenStartInput, setVTokenStartInput] = useState<string>(DEFAULT_VIRTUAL_TOKEN_START);

  const etxEditedRef = useRef(false);
  const treasuryEditedRef = useRef(false);
  const etiLpSinkEditedRef = useRef(false);
  const ownerEditedRef = useRef(false);
  const [state, setState] = useState<DeployState>({ status: 'idle' });

  useEffect(() => {
    if (!etxEditedRef.current) setEtxInput(defaultEtx);
  }, [defaultEtx]);
  useEffect(() => {
    if (!treasuryEditedRef.current) setTreasuryInput(defaultTreasury);
  }, [defaultTreasury]);
  useEffect(() => {
    if (!etiLpSinkEditedRef.current) setEtiLpSinkInput(defaultEtiLpSink);
  }, [defaultEtiLpSink]);
  useEffect(() => {
    if (!ownerEditedRef.current) setOwnerInput(defaultOwner);
  }, [defaultOwner]);

  function parseAddrInput(v: string): Address | null {
    try {
      const a = getAddress(v.trim());
      return a === ZERO_ADDRESS ? null : a;
    } catch {
      return null;
    }
  }

  const parsedEtx = useMemo(() => parseAddrInput(etxInput), [etxInput]);
  const parsedTreasury = useMemo(() => parseAddrInput(treasuryInput), [treasuryInput]);
  const parsedEtiLpSink = useMemo(() => parseAddrInput(etiLpSinkInput), [etiLpSinkInput]);
  const parsedOwner = useMemo(() => parseAddrInput(ownerInput), [ownerInput]);

  function parseBpsInput(v: string, max: number): number | null {
    const n = Number(v.trim());
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > max) return null;
    return n;
  }

  function parseEtherInput(v: string): bigint | null {
    try {
      return parseEther(v.trim() as `${number}`);
    } catch {
      return null;
    }
  }

  const parsedLaunchToll = useMemo(() => parseEtherInput(launchTollInput), [launchTollInput]);
  const parsedFeeRateBps = useMemo(() => parseBpsInput(feeRateBpsInput, 500), [feeRateBpsInput]);
  const parsedEtiLpBps = useMemo(() => parseBpsInput(etiLpBpsInput, 10000), [etiLpBpsInput]);
  const parsedTreasuryBps = useMemo(
    () => parseBpsInput(treasuryBpsInput, 10000),
    [treasuryBpsInput],
  );
  const parsedResearcherBps = useMemo(
    () => parseBpsInput(researcherBpsInput, 10000),
    [researcherBpsInput],
  );
  const parsedGraduationThreshold = useMemo(
    () => parseEtherInput(graduationThresholdInput),
    [graduationThresholdInput],
  );
  const parsedSunsetWindow = useMemo(() => {
    const n = Number(sunsetWindowInput.trim());
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 7 * 24 * 60 * 60) return null;
    return n;
  }, [sunsetWindowInput]);
  const parsedVEtxStart = useMemo(() => parseEtherInput(vEtxStartInput), [vEtxStartInput]);
  const parsedVTokenStart = useMemo(() => parseEtherInput(vTokenStartInput), [vTokenStartInput]);

  const splitSum =
    (parsedEtiLpBps ?? 0) + (parsedTreasuryBps ?? 0) + (parsedResearcherBps ?? 0);
  const splitValid = splitSum <= 10000;
  const poolBps = 10000 - splitSum;

  const allParsed =
    parsedEtx !== null &&
    parsedTreasury !== null &&
    parsedEtiLpSink !== null &&
    parsedOwner !== null &&
    parsedLaunchToll !== null &&
    parsedFeeRateBps !== null &&
    parsedEtiLpBps !== null &&
    parsedTreasuryBps !== null &&
    parsedResearcherBps !== null &&
    parsedGraduationThreshold !== null &&
    parsedSunsetWindow !== null &&
    parsedVEtxStart !== null &&
    parsedVTokenStart !== null &&
    splitValid;

  async function onDeploy() {
    if (
      !walletClient ||
      !publicClient ||
      !address ||
      !parsedEtx ||
      !parsedTreasury ||
      !parsedEtiLpSink ||
      !parsedOwner ||
      parsedLaunchToll === null ||
      parsedFeeRateBps === null ||
      parsedEtiLpBps === null ||
      parsedTreasuryBps === null ||
      parsedResearcherBps === null ||
      parsedGraduationThreshold === null ||
      parsedSunsetWindow === null ||
      parsedVEtxStart === null ||
      parsedVTokenStart === null ||
      !splitValid
    ) {
      return;
    }
    setState({ status: 'signing' });

    let txHash: Hex;
    try {
      const ctorStruct = {
        etx: parsedEtx,
        treasury: parsedTreasury,
        etiLpSink: parsedEtiLpSink,
        owner: parsedOwner,
        launchTollEtx: parsedLaunchToll,
        feeRateBps: parsedFeeRateBps,
        etiLpBps: parsedEtiLpBps,
        treasuryBps: parsedTreasuryBps,
        researcherBps: parsedResearcherBps,
        graduationThreshold: parsedGraduationThreshold,
        sunsetWindow: parsedSunsetWindow,
        defaultVirtualEtxStart: parsedVEtxStart,
        defaultVirtualTokenStart: parsedVTokenStart,
      };
      const data = encodeDeployData({
        abi: eticaResearchMarketsArtifact.abi,
        bytecode: eticaResearchMarketsArtifact.bytecode as Hex,
        args: [ctorStruct],
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
          The <span className="font-mono">EticaResearchMarkets</span> singleton — a custom
          V4-style router that owns the shared 5M ETX research pool and is the sole mint/burn
          authority for every <span className="font-mono">ResearchToken</span> it launches. No LP
          positions exist; all liquidity sits inside this contract and is priced via a
          constant-product bonding curve against per-market virtual reserves.
        </p>
        <p className="mt-2 text-sm text-white/70">
          Compiled with <span className="font-mono">{eticaResearchMarketsArtifact.version}</span>.
          Every parameter below is owner-tunable post-deploy via the singleton&apos;s setters — no
          redeploy required.
        </p>
      </section>

      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-3 text-lg font-semibold">Key properties</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-white/70">
          <li>
            <span className="font-mono">launch(metadata)</span> charges a fixed
            <span className="font-mono"> launchTollEtx</span> (default 100 ETX) routed directly to
            the shared pool, deploys a <span className="font-mono">ResearchToken</span> with the
            researcher&apos;s metadata (image, description, socials, evidence URI) all on-chain,
            and registers a new market with the default virtual reserves.
          </li>
          <li>
            <span className="font-mono">buy</span> / <span className="font-mono">sell</span> mint
            and burn <span className="font-mono">ResearchToken</span>s against the singleton
            (never to a dead address). The shared pool ETX balance ebbs and flows with net trading
            pressure across all markets.
          </li>
          <li>
            Every trade takes a 1% fee in ETX (capped at 5%) routed{' '}
            <span className="font-mono">40 / 30 / 20 / 10</span> — pool (compounds the 5M seed) /
            etiLpSink (POL burn) / treasury / researcher.
          </li>
          <li>
            <span className="font-mono">Graduation</span> at 100k ETX reserve is a UI-only flag —
            the <span className="font-mono">Graduated</span> event fires, the token shows up in
            <span className="font-mono"> /swap</span> + <span className="font-mono">/trade</span>{' '}
            pickers, and the curve stays the venue forever. No contract migration, no LP
            creation.
          </li>
          <li>
            <span className="font-mono">Sunset</span> after 30 days of no trades flips a UI-only
            flag so dormant markets stop being promoted. The curve remains fully functional;
            holders can still sell. The next trade auto-unsets the flag.
          </li>
          <li>
            Every <span className="font-mono">ResearchToken</span> the singleton deploys is
            bytecode-deterministic — one canonical Sourcify metadata bundle verifies every future
            mint at zero cost, eliminating the bytecode-opacity vector MEV bots exploit.
          </li>
        </ul>
      </section>

      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-4 text-lg font-semibold">Constructor — addresses</h2>
        <div className="space-y-4">
          <label className="block text-sm text-white/70">
            ETX token
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
          <label className="block text-sm text-white/70">
            Treasury multisig (receives the treasury slice — default 0% under C-with-lock)
            <input
              type="text"
              className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-white placeholder:text-white/30"
              value={treasuryInput}
              onChange={(e) => {
                treasuryEditedRef.current = true;
                setTreasuryInput(e.target.value);
              }}
              placeholder="0x…"
              spellCheck={false}
            />
          </label>
          <label className="block text-sm text-white/70">
            ETI LP sink (receives 10% of trade fees — POL burn target, deepens ETI/ETX)
            <input
              type="text"
              className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-white placeholder:text-white/30"
              value={etiLpSinkInput}
              onChange={(e) => {
                etiLpSinkEditedRef.current = true;
                setEtiLpSinkInput(e.target.value);
              }}
              placeholder="0x…"
              spellCheck={false}
            />
            <span className="mt-1 block text-xs text-white/40">
              Defaults to the treasury until a dedicated POL-burn contract is deployed. Rotatable
              via <span className="font-mono">setEtiLpSink</span>.
            </span>
          </label>
          <label className="block text-sm text-white/70">
            Owner (post-deploy admin — sets fee rate, split, thresholds)
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
        </div>
      </section>

      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-4 text-lg font-semibold">Constructor — economics</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm text-white/70">
            Launch toll (ETX, paid to pool)
            <input
              type="text"
              className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-white"
              value={launchTollInput}
              onChange={(e) => setLaunchTollInput(e.target.value)}
            />
          </label>
          <label className="block text-sm text-white/70">
            Fee rate (bps, ≤ 500 = 5%)
            <input
              type="text"
              className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-white"
              value={feeRateBpsInput}
              onChange={(e) => setFeeRateBpsInput(e.target.value)}
            />
          </label>
          <label className="block text-sm text-white/70">
            ETI LP slice (bps of fee)
            <input
              type="text"
              className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-white"
              value={etiLpBpsInput}
              onChange={(e) => setEtiLpBpsInput(e.target.value)}
            />
          </label>
          <label className="block text-sm text-white/70">
            Treasury slice (bps of fee)
            <input
              type="text"
              className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-white"
              value={treasuryBpsInput}
              onChange={(e) => setTreasuryBpsInput(e.target.value)}
            />
          </label>
          <label className="block text-sm text-white/70">
            Researcher slice (bps of fee)
            <input
              type="text"
              className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-white"
              value={researcherBpsInput}
              onChange={(e) => setResearcherBpsInput(e.target.value)}
            />
          </label>
          <div className="block text-sm text-white/70">
            Pool slice (residual, bps of fee)
            <div className="mt-1 w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 font-mono text-xs text-white/80">
              {splitValid ? poolBps : 'invalid — split sum > 10000'}
            </div>
            <span className="mt-1 block text-xs text-white/40">
              Auto-computed as <span className="font-mono">10000 - etiLp - treasury - researcher</span>.
              Compounds the shared 5M pool with every trade.
            </span>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-4 text-lg font-semibold">Constructor — curve & lifecycle</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm text-white/70">
            Graduation threshold (ETX reserve)
            <input
              type="text"
              className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-white"
              value={graduationThresholdInput}
              onChange={(e) => setGraduationThresholdInput(e.target.value)}
            />
            <span className="mt-1 block text-xs text-white/40">
              UI-only flag — no migration. Tunable via{' '}
              <span className="font-mono">setGraduationThreshold</span>.
            </span>
          </label>
          <label className="block text-sm text-white/70">
            Sunset window (seconds, min 7d)
            <input
              type="text"
              className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-white"
              value={sunsetWindowInput}
              onChange={(e) => setSunsetWindowInput(e.target.value)}
            />
          </label>
          <label className="block text-sm text-white/70">
            Default virtual ETX start (per market)
            <input
              type="text"
              className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-white"
              value={vEtxStartInput}
              onChange={(e) => setVEtxStartInput(e.target.value)}
            />
          </label>
          <label className="block text-sm text-white/70">
            Default virtual token start (per market)
            <input
              type="text"
              className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-white"
              value={vTokenStartInput}
              onChange={(e) => setVTokenStartInput(e.target.value)}
            />
          </label>
        </div>
      </section>

      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-3 text-lg font-semibold">Deploy</h2>

        {!isConnected ? (
          <button
            type="button"
            className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 disabled:opacity-50"
            disabled={connectStatus === 'pending' || !injectedConnector}
            onClick={() => injectedConnector && connect({ connector: injectedConnector })}
          >
            {connectStatus === 'pending' ? 'Connecting…' : 'Connect wallet'}
          </button>
        ) : !onMainnet ? (
          <div className="space-y-3">
            <p className="text-sm text-amber-300/90">
              Connected to chain <span className="font-mono">{chainId}</span>. Switch to Etica
              mainnet (<span className="font-mono">{eticaMainnet.id}</span>) before deploying.
            </p>
            <button
              type="button"
              className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 disabled:opacity-50"
              disabled={switching}
              onClick={() => switchChain({ chainId: eticaMainnet.id })}
            >
              {switching ? 'Switching…' : `Switch to Etica (${eticaMainnet.id})`}
            </button>
            <button
              type="button"
              className="ml-2 rounded-md border border-white/20 px-4 py-2 text-sm font-medium text-white/80"
              onClick={() => disconnect()}
            >
              Disconnect
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-white/70">
              Connected as <span className="font-mono">{address}</span> on chain{' '}
              <span className="font-mono">{chainId}</span>.
            </p>
            <button
              type="button"
              className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 disabled:opacity-50"
              disabled={
                !walletClient ||
                !allParsed ||
                state.status === 'signing' ||
                state.status === 'pending'
              }
              onClick={onDeploy}
            >
              {state.status === 'signing'
                ? 'Awaiting signature…'
                : state.status === 'pending'
                  ? 'Confirming…'
                  : 'Deploy EticaResearchMarkets'}
            </button>
            <button
              type="button"
              className="ml-2 rounded-md border border-white/20 px-4 py-2 text-sm font-medium text-white/80"
              onClick={() => disconnect()}
            >
              Disconnect
            </button>
          </div>
        )}

        {state.status === 'confirmed' && state.address ? (
          <div className="mt-4 space-y-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm">
            <div className="font-semibold text-emerald-300">
              Deployed at <span className="font-mono">{state.address}</span>
            </div>
            <div className="text-emerald-200/80">
              Tx <span className="font-mono">{state.txHash}</span>
            </div>
            <div className="text-white/70">
              Next steps:
              <ol className="mt-1 list-decimal space-y-1 pl-5">
                <li>
                  Paste this address into{' '}
                  <span className="font-mono">packages/shared/src/addresses.ts</span> under{' '}
                  <span className="font-mono">
                    DEPLOYMENTS[{eticaMainnet.id}].eticaResearchMarkets
                  </span>
                  .
                </li>
                <li>
                  Transfer the 5M ETX seed into the singleton:{' '}
                  <span className="font-mono">
                    IERC20(etx).transfer({state.address.slice(0, 10)}…, 5_000_000e18)
                  </span>
                  .
                </li>
                <li>
                  (Optional) Re-tune fee rate, fee split, graduation threshold, sunset window
                  before any research-token launches via the owner-gated setters.
                </li>
              </ol>
            </div>
          </div>
        ) : null}

        {state.status === 'pending' && state.txHash ? (
          <p className="mt-4 text-sm text-white/70">
            Waiting for confirmation: <span className="font-mono">{state.txHash}</span>
          </p>
        ) : null}

        {state.status === 'error' ? (
          <p className="mt-4 text-sm text-rose-300">
            {state.error}
            {state.txHash ? (
              <>
                {' '}
                — tx <span className="font-mono">{state.txHash}</span>
              </>
            ) : null}
          </p>
        ) : null}
      </section>
    </div>
  );
}
