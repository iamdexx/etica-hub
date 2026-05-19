'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BaseError,
  UserRejectedRequestError,
  encodeDeployData,
  formatEther,
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
import eticaResearchNftArtifact from '@/lib/etica-research-nft-artifact.json';
import eticaResearchNftMetadataArtifact from '@/lib/etica-research-nft-metadata-artifact.json';

/**
 * Two-step browser deployer for {@link EticaResearchNFT}.
 *
 * Step 1 deploys the {@link EticaResearchNFTMetadata} library (pure on-chain
 * SVG + JSON tokenURI builder). Step 2 substitutes the deployed library
 * address into the NFT bytecode's link placeholder and deploys the
 * NFT with the 5 constructor args:
 *
 *   - `attestor_`   : single immutable address authorised to sign
 *                     ClaimPayloads. Cannot transfer, freeze, or revoke any
 *                     NFT — it only authorises mints. Generated server-side
 *                     and stored in Vercel env `LABS_ATTESTOR_PRIVATE_KEY`;
 *                     this field is pre-filled with the matching public
 *                     address.
 *   - `treasury_`   : protocol treasury multisig. Receives the immutable
 *                     1% treasury slice of every mint and every secondary-
 *                     sale royalty, and is the recipient of any post-7d
 *                     auto-forfeited NFT. Defaults to {@link TREASURY_ADDRESS}.
 *   - `baseUrl_`    : base URL embedded in tokenURI for the off-chain 3D
 *                     viewer and external link (e.g. `https://eticahub.com`).
 *                     The SVG card itself is fully on-chain — `baseUrl_` only
 *                     gates the `animation_url` and `external_url` fields.
 *   - `baseMintFeeWei_`     : flat EGAZ leg of the mint fee (paid on every
 *                             non-treasury mint). Default 1 EGAZ.
 *   - `maxScoreMintFeeWei_` : score-indexed cap of the mint fee — actual
 *                             score-indexed leg = MAX × score / 10000, so a
 *                             score-1.0 record pays the full cap. Default
 *                             9 EGAZ. Total at score 1.0 = 1 + 9 = 10 EGAZ.
 *
 * No private key ever leaves the browser. Library + NFT are deployed in
 * sequence from the same wallet — the user signs two transactions back-to-
 * back, the second one only after the first confirms (so we have a real
 * library address to substitute).
 *
 * After both confirm, the operator pastes the deployed NFT address (and
 * library address, for future Sourcify verification) into
 * `packages/shared/src/addresses.ts` under
 * `DEPLOYMENTS[61803].eticaResearchNft` and
 * `DEPLOYMENTS[61803].eticaResearchNftMetadataLib`.
 */

type DeployState =
  | { status: 'idle' }
  | { status: 'lib-signing' }
  | { status: 'lib-pending'; txHash: Hex }
  | { status: 'lib-confirmed'; libTxHash: Hex; libAddress: Address }
  | { status: 'nft-signing'; libTxHash: Hex; libAddress: Address }
  | {
      status: 'nft-pending';
      libTxHash: Hex;
      libAddress: Address;
      txHash: Hex;
    }
  | {
      status: 'confirmed';
      libTxHash: Hex;
      libAddress: Address;
      txHash: Hex;
      nftAddress: Address;
    }
  | { status: 'error'; error: string; libTxHash?: Hex; libAddress?: Address; txHash?: Hex };

function shortError(err: unknown): string {
  if (err instanceof UserRejectedRequestError) return 'Rejected in wallet.';
  if (err instanceof BaseError) return err.shortMessage ?? err.message;
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

// Generated locally and stored as `LABS_ATTESTOR_PRIVATE_KEY` in Vercel env.
// This is the matching PUBLIC address — safe to bake into the constructor.
const DEFAULT_ATTESTOR_ADDRESS: Address = '0xb8a4A836Dfd2c79aEfcECF03805B2944095361ad';

const DEFAULT_BASE_URL = 'https://eticahub.com';
const DEFAULT_BASE_MINT_FEE_EGAZ = '1'; // 1 EGAZ flat
const DEFAULT_MAX_SCORE_MINT_FEE_EGAZ = '9'; // up to 9 EGAZ score-indexed → 10 EGAZ max at score 1.0

/**
 * Substitutes the deployed library address into every link placeholder
 * in `bytecode`. Foundry/solc emit placeholders of the form
 * `__$<keccak hash>$__` (40 chars), which we replace with the 40-char
 * lowercase hex address. Operates on a 0x-prefixed hex string and
 * preserves the prefix.
 */
function linkLibrary(bytecode: string, libraryAddress: Address): Hex {
  const placeholder = /__\$[a-f0-9]+\$__/g;
  const addrHex = libraryAddress.toLowerCase().slice(2); // strip 0x
  if (addrHex.length !== 40) {
    throw new Error(`linkLibrary: library address must be 20 bytes, got ${addrHex.length / 2}`);
  }
  const linked = bytecode.replace(placeholder, addrHex);
  if (placeholder.test(linked)) {
    throw new Error('linkLibrary: unresolved link placeholders remain after substitution');
  }
  return (linked.startsWith('0x') ? linked : `0x${linked}`) as Hex;
}

export function DeployResearchNftCard() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { connectors, connect, status: connectStatus } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();

  const onMainnet = chainId === eticaMainnet.id;
  const defaultTreasury = TREASURY_ADDRESS;
  const existingLib = onMainnet
    ? DEPLOYMENTS[eticaMainnet.id].eticaResearchNftMetadataLib
    : ZERO_ADDRESS;
  const existingNft = onMainnet ? DEPLOYMENTS[eticaMainnet.id].eticaResearchNft : ZERO_ADDRESS;

  const [attestorInput, setAttestorInput] = useState<string>(DEFAULT_ATTESTOR_ADDRESS);
  const [treasuryInput, setTreasuryInput] = useState<string>(defaultTreasury);
  const [baseUrlInput, setBaseUrlInput] = useState<string>(DEFAULT_BASE_URL);
  const [baseMintFeeInput, setBaseMintFeeInput] = useState<string>(DEFAULT_BASE_MINT_FEE_EGAZ);
  const [maxScoreMintFeeInput, setMaxScoreMintFeeInput] = useState<string>(
    DEFAULT_MAX_SCORE_MINT_FEE_EGAZ,
  );
  // Optional: skip step 1 and reuse a previously deployed library. Useful for
  // re-deploying only the NFT (e.g. after rotating treasury) without spending
  // gas to re-deploy ~21KB of identical library bytecode.
  const [reuseLibInput, setReuseLibInput] = useState<string>(existingLib);

  const attestorEditedRef = useRef(false);
  const treasuryEditedRef = useRef(false);
  const reuseLibEditedRef = useRef(false);

  const [state, setState] = useState<DeployState>({ status: 'idle' });

  useEffect(() => {
    if (!attestorEditedRef.current) setAttestorInput(DEFAULT_ATTESTOR_ADDRESS);
  }, []);
  useEffect(() => {
    if (!treasuryEditedRef.current) setTreasuryInput(defaultTreasury);
  }, [defaultTreasury]);
  useEffect(() => {
    if (!reuseLibEditedRef.current) setReuseLibInput(existingLib);
  }, [existingLib]);

  function parseAddrInput(v: string, allowZero = false): Address | null {
    try {
      const a = getAddress(v.trim());
      if (!allowZero && a === ZERO_ADDRESS) return null;
      return a;
    } catch {
      return null;
    }
  }

  function parseEtherInput(v: string): bigint | null {
    try {
      return parseEther(v.trim() as `${number}`);
    } catch {
      return null;
    }
  }

  const parsedAttestor = useMemo(() => parseAddrInput(attestorInput), [attestorInput]);
  const parsedTreasury = useMemo(() => parseAddrInput(treasuryInput), [treasuryInput]);
  const parsedReuseLib = useMemo(() => parseAddrInput(reuseLibInput, true), [reuseLibInput]);
  const reuseLib = parsedReuseLib && parsedReuseLib !== ZERO_ADDRESS ? parsedReuseLib : null;
  const parsedBaseMintFee = useMemo(() => parseEtherInput(baseMintFeeInput), [baseMintFeeInput]);
  const parsedMaxScoreMintFee = useMemo(
    () => parseEtherInput(maxScoreMintFeeInput),
    [maxScoreMintFeeInput],
  );
  const baseUrlValid = baseUrlInput.trim().length > 0 && baseUrlInput.trim().length < 200;

  const allParsed =
    parsedAttestor !== null &&
    parsedTreasury !== null &&
    parsedBaseMintFee !== null &&
    parsedMaxScoreMintFee !== null &&
    baseUrlValid;

  async function deployLibrary(): Promise<Address> {
    if (!walletClient || !publicClient || !address) throw new Error('Wallet not ready');
    setState({ status: 'lib-signing' });
    const data = encodeDeployData({
      abi: eticaResearchNftMetadataArtifact.abi,
      bytecode: eticaResearchNftMetadataArtifact.bytecode as Hex,
      args: [],
    });
    const txHash = await walletClient.sendTransaction({ account: address, data });
    setState({ status: 'lib-pending', txHash });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success' || !receipt.contractAddress) {
      throw new Error('Library deploy failed: ' + (receipt.status ?? 'no contractAddress'));
    }
    const libAddress = receipt.contractAddress as Address;
    setState({ status: 'lib-confirmed', libTxHash: txHash, libAddress });
    return libAddress;
  }

  async function deployNft(
    libAddress: Address,
    libTxHash: Hex | undefined,
  ): Promise<void> {
    if (
      !walletClient ||
      !publicClient ||
      !address ||
      !parsedAttestor ||
      !parsedTreasury ||
      parsedBaseMintFee === null ||
      parsedMaxScoreMintFee === null
    ) {
      throw new Error('Form not ready');
    }
    setState({ status: 'nft-signing', libTxHash: libTxHash ?? ('0x' as Hex), libAddress });
    const linkedBytecode = linkLibrary(
      eticaResearchNftArtifact.bytecode as string,
      libAddress,
    );
    const data = encodeDeployData({
      abi: eticaResearchNftArtifact.abi,
      bytecode: linkedBytecode,
      args: [
        parsedAttestor,
        parsedTreasury,
        baseUrlInput.trim(),
        parsedBaseMintFee,
        parsedMaxScoreMintFee,
      ],
    });
    const txHash = await walletClient.sendTransaction({ account: address, data });
    setState({
      status: 'nft-pending',
      libTxHash: libTxHash ?? ('0x' as Hex),
      libAddress,
      txHash,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success' || !receipt.contractAddress) {
      throw new Error('NFT deploy failed: ' + (receipt.status ?? 'no contractAddress'));
    }
    setState({
      status: 'confirmed',
      libTxHash: libTxHash ?? ('0x' as Hex),
      libAddress,
      txHash,
      nftAddress: receipt.contractAddress as Address,
    });
  }

  async function onDeploy() {
    try {
      const libAddress = reuseLib ?? (await deployLibrary());
      await deployNft(libAddress, reuseLib ? undefined : (state as { txHash?: Hex }).txHash);
    } catch (err) {
      setState((prev) => ({
        status: 'error',
        error: shortError(err),
        libTxHash: 'libTxHash' in prev ? prev.libTxHash : undefined,
        libAddress: 'libAddress' in prev ? prev.libAddress : undefined,
        txHash: 'txHash' in prev ? prev.txHash : undefined,
      }));
    }
  }

  const injectedConnector = connectors.find((c) => c.id === 'injected') ?? connectors[0];

  const busy =
    state.status === 'lib-signing' ||
    state.status === 'lib-pending' ||
    state.status === 'lib-confirmed' ||
    state.status === 'nft-signing' ||
    state.status === 'nft-pending';

  const maxFeeAtScoreOne = useMemo(() => {
    if (parsedBaseMintFee === null || parsedMaxScoreMintFee === null) return null;
    return parsedBaseMintFee + parsedMaxScoreMintFee;
  }, [parsedBaseMintFee, parsedMaxScoreMintFee]);

  const alreadyDeployed = existingNft !== ZERO_ADDRESS;

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-3 text-lg font-semibold">What this deploys</h2>
        <p className="text-sm text-white/70">
          The <span className="font-mono">EticaResearchNFT</span> — an immutable ERC-721 minted
          once per published research candidate (RES). Every mint and every secondary-sale
          royalty splits <span className="font-mono">79 / 20 / 1</span>: 79% current holder,
          20% to ancestors cascading geometrically up the parent chain (80/20 at each level,
          depth-25 cap), 1% to treasury. Reverting ancestor wallets fall through to the current
          holder, so treasury is never compounded past its 1% slice. Per-token CREATE2 royalty
          splitter contracts hold and release EGAZ + any ERC-20 royalty payments.
        </p>
        <p className="mt-2 text-sm text-white/70">
          The single immutable <span className="font-mono">ATTESTOR</span> address baked into
          the constructor signs ClaimPayloads off-chain; it cannot transfer, freeze, or revoke
          any NFT — it only authorises mints. The private key matching the prefilled
          attestor address is already stored in Vercel env as{' '}
          <span className="font-mono">LABS_ATTESTOR_PRIVATE_KEY</span> and is never exposed in
          this UI.
        </p>
        <p className="mt-2 text-sm text-white/70">
          Two transactions: <strong>(1)</strong> deploys the{' '}
          <span className="font-mono">EticaResearchNFTMetadata</span> on-chain SVG/JSON builder
          (~21 KB, extracted to keep the NFT under the EIP-170 size cap), <strong>(2)</strong>{' '}
          deploys the NFT linked to that library. No private key ever leaves the browser.
        </p>
        <p className="mt-2 text-sm text-white/70">
          Compiled with{' '}
          <span className="font-mono">{eticaResearchNftArtifact.version}</span>.
        </p>
        {alreadyDeployed ? (
          <p className="mt-3 text-sm text-amber-300/90">
            Heads up: an EticaResearchNFT is already wired into{' '}
            <span className="font-mono">addresses.ts</span> at{' '}
            <span className="font-mono">{existingNft}</span>. Re-deploying creates a parallel
            contract — the existing one keeps minting until the new address is wired in.
          </p>
        ) : null}
      </section>

      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-3 text-lg font-semibold">Key properties</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-white/70">
          <li>
            <span className="font-mono">claim(payload, sig)</span> mints a new RES.
            Discoverer (in the 30-min exclusive window) pays{' '}
            <span className="font-mono">
              BASE_MINT_FEE_WEI + MAX_SCORE_MINT_FEE_WEI × score / 10000
            </span>{' '}
            in <span className="font-mono">msg.value</span>; overpayment is refunded. After
            the exclusive window expires, anyone can call to force-mint to treasury — the fee
            is fully waived on that auto-forfeit path.
          </li>
          <li>
            <span className="font-mono">tokenURI</span> renders a fully on-chain SVG card +
            JSON metadata via <span className="font-mono">EticaResearchNFTMetadata</span> —
            zero IPFS dependency. The card shows{' '}
            <span className="font-mono">ETICARESEARCH / RES #&lt;id&gt; / &lt;goal title&gt;</span>{' '}
            and a sequence preview. The JSON sets{' '}
            <span className="font-mono">animation_url</span> to{' '}
            <span className="font-mono">&lt;baseUrl&gt;/labs/research/&lt;id&gt;/viewer</span>,
            which renders the live NVIDIA-folded 3D protein in any marketplace that supports
            animation_url (OpenSea, Magic Eden, Zora).
          </li>
          <li>
            <span className="font-mono">ATTESTOR</span> is immutable. Rotating it requires
            deploying a new EticaResearchNFT and re-pointing the labs mint flow. There is no
            owner, no pauser, no upgrade path — the contract is set in stone the moment this
            tx confirms.
          </li>
          <li>
            <span className="font-mono">treasury</span> is the post-7d auto-forfeit recipient
            AND the 1% protocol-fee leg of every mint and every secondary-sale royalty.
            Mutable only via the contract&apos;s existing treasury rotation function (no admin
            on royalty math).
          </li>
        </ul>
      </section>

      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-4 text-lg font-semibold">Constructor</h2>
        <div className="space-y-4">
          <label className="block text-sm text-white/70">
            Attestor (signs ClaimPayloads; immutable)
            <input
              type="text"
              className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-white placeholder:text-white/30"
              value={attestorInput}
              onChange={(e) => {
                attestorEditedRef.current = true;
                setAttestorInput(e.target.value);
              }}
              placeholder="0x…"
              spellCheck={false}
            />
            <span className="mt-1 block text-xs text-white/40">
              Prefilled with the public address whose private key is stored in Vercel env as{' '}
              <span className="font-mono">LABS_ATTESTOR_PRIVATE_KEY</span>. Change only if you
              rotated the key.
            </span>
          </label>
          <label className="block text-sm text-white/70">
            Treasury (1% royalty + post-7d auto-forfeit recipient)
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
            Base URL (embedded in tokenURI for the 3D viewer link)
            <input
              type="text"
              className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-white placeholder:text-white/30"
              value={baseUrlInput}
              onChange={(e) => setBaseUrlInput(e.target.value)}
              placeholder="https://eticahub.com"
              spellCheck={false}
            />
            <span className="mt-1 block text-xs text-white/40">
              SVG card is fully on-chain. Only{' '}
              <span className="font-mono">animation_url</span> and{' '}
              <span className="font-mono">external_url</span> use this base URL.
            </span>
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm text-white/70">
              Base mint fee (EGAZ — paid on every non-treasury mint)
              <input
                type="text"
                className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-white"
                value={baseMintFeeInput}
                onChange={(e) => setBaseMintFeeInput(e.target.value)}
              />
            </label>
            <label className="block text-sm text-white/70">
              Max score-indexed fee (EGAZ — cap at score 1.0)
              <input
                type="text"
                className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-white"
                value={maxScoreMintFeeInput}
                onChange={(e) => setMaxScoreMintFeeInput(e.target.value)}
              />
            </label>
          </div>
          {maxFeeAtScoreOne !== null ? (
            <p className="text-xs text-white/50">
              Total mint fee at score 1.0 ={' '}
              <span className="font-mono">{formatEther(maxFeeAtScoreOne)}</span> EGAZ. At score
              0.5, ~
              <span className="font-mono">
                {parsedBaseMintFee !== null && parsedMaxScoreMintFee !== null
                  ? formatEther(parsedBaseMintFee + parsedMaxScoreMintFee / 2n)
                  : '—'}
              </span>{' '}
              EGAZ.
            </p>
          ) : null}
        </div>
      </section>

      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <h2 className="mb-3 text-lg font-semibold">Library (advanced)</h2>
        <label className="block text-sm text-white/70">
          Reuse existing EticaResearchNFTMetadata library (optional)
          <input
            type="text"
            className="mt-1 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-white placeholder:text-white/30"
            value={reuseLibInput}
            onChange={(e) => {
              reuseLibEditedRef.current = true;
              setReuseLibInput(e.target.value);
            }}
            placeholder="0x… (leave 0x0 to deploy a fresh library)"
            spellCheck={false}
          />
          <span className="mt-1 block text-xs text-white/40">
            If a previous deploy already published the library to chain{' '}
            <span className="font-mono">{eticaMainnet.id}</span>, paste its address here to
            skip step 1 and save ~21 KB of redundant bytecode gas. Leave as the zero address
            to deploy a fresh copy.
          </span>
        </label>
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
              disabled={!walletClient || !allParsed || busy}
              onClick={onDeploy}
            >
              {state.status === 'lib-signing'
                ? 'Awaiting library signature…'
                : state.status === 'lib-pending'
                  ? 'Confirming library deploy…'
                  : state.status === 'lib-confirmed'
                    ? 'Library confirmed — opening NFT signature…'
                    : state.status === 'nft-signing'
                      ? 'Awaiting NFT signature…'
                      : state.status === 'nft-pending'
                        ? 'Confirming NFT deploy…'
                        : reuseLib
                          ? 'Deploy EticaResearchNFT (skip library)'
                          : 'Deploy library + NFT'}
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

        {state.status === 'lib-confirmed' || state.status === 'nft-signing' || state.status === 'nft-pending' ? (
          <div className="mt-4 space-y-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm">
            <div className="font-semibold text-emerald-300">
              Library deployed at <span className="font-mono">{state.libAddress}</span>
            </div>
            <div className="text-emerald-200/80">
              Tx <span className="font-mono">{state.libTxHash}</span>
            </div>
          </div>
        ) : null}

        {state.status === 'confirmed' ? (
          <div className="mt-4 space-y-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm">
            <div className="font-semibold text-emerald-300">
              EticaResearchNFT deployed at{' '}
              <span className="font-mono">{state.nftAddress}</span>
            </div>
            <div className="text-emerald-200/80">
              Library at <span className="font-mono">{state.libAddress}</span>
            </div>
            <div className="text-emerald-200/80">
              NFT tx <span className="font-mono">{state.txHash}</span>
            </div>
            <div className="text-emerald-200/80">
              Library tx <span className="font-mono">{state.libTxHash}</span>
            </div>
            <div className="text-white/70">
              Next steps:
              <ol className="mt-1 list-decimal space-y-1 pl-5">
                <li>
                  Paste both addresses into{' '}
                  <span className="font-mono">packages/shared/src/addresses.ts</span> under{' '}
                  <span className="font-mono">
                    DEPLOYMENTS[{eticaMainnet.id}].eticaResearchNft
                  </span>{' '}
                  and{' '}
                  <span className="font-mono">
                    DEPLOYMENTS[{eticaMainnet.id}].eticaResearchNftMetadataLib
                  </span>
                  .
                </li>
                <li>
                  The labs mint flow at <span className="font-mono">/labs/feed/[id]</span>{' '}
                  reads the NFT address from{' '}
                  <span className="font-mono">addresses.ts</span> — once it&apos;s wired in,
                  the &quot;Mint as RES&quot; button on every published candidate becomes
                  active.
                </li>
                <li>
                  Verify both contracts on Sourcify (see{' '}
                  <span className="font-mono">docs/sourcify/</span>) — bytecode is
                  deterministic so a single canonical metadata bundle covers all future
                  deploys.
                </li>
              </ol>
            </div>
          </div>
        ) : null}

        {state.status === 'lib-pending' ? (
          <p className="mt-4 text-sm text-white/70">
            Waiting for library confirmation: <span className="font-mono">{state.txHash}</span>
          </p>
        ) : null}

        {state.status === 'nft-pending' ? (
          <p className="mt-4 text-sm text-white/70">
            Waiting for NFT confirmation: <span className="font-mono">{state.txHash}</span>
          </p>
        ) : null}

        {state.status === 'error' ? (
          <p className="mt-4 text-sm text-rose-300">
            {state.error}
            {state.libAddress ? (
              <>
                {' '}
                — library at <span className="font-mono">{state.libAddress}</span>
              </>
            ) : null}
            {state.txHash ? (
              <>
                {' '}
                — last tx <span className="font-mono">{state.txHash}</span>
              </>
            ) : null}
          </p>
        ) : null}
      </section>
    </div>
  );
}
