import type { Address } from 'viem';
import type { SupportedChainId } from './chains';

/**
 * Canonical, externally-controlled addresses on each chain.
 *
 * These are NOT our deployments — they are the Etica protocol's own contracts
 * and tokens that EticaHub reads from or interacts with.
 */
export const EXTERNAL_ADDRESSES: Record<
  SupportedChainId,
  {
    /** Etica protocol's core smart contract (also acts as the ETI ERC20). */
    eticaCore: Address;
    /** ETI token address (same as eticaCore on Etica). */
    eti: Address;
  }
> = {
  61803: {
    eticaCore: '0x34c61EA91bAcdA647269d4e310A86b875c09946f',
    eti: '0x34c61EA91bAcdA647269d4e310A86b875c09946f',
  },
  61888: {
    eticaCore: '0x558593Bc92E6F242a604c615d93902fc98efcA82',
    eti: '0x558593Bc92E6F242a604c615d93902fc98efcA82',
  },
  31337: {
    // Local anvil fork inherits mainnet state, so ETI lives at the mainnet address.
    eticaCore: '0x34c61EA91bAcdA647269d4e310A86b875c09946f',
    eti: '0x34c61EA91bAcdA647269d4e310A86b875c09946f',
  },
};

/**
 * EticaHub deployments, populated from deploy artifacts after a deploy run.
 *
 * Before the first deployment, entries are zero. The deploy script in
 * `packages/contracts/script/DeploySwap.s.sol` writes the resulting addresses
 * into this file (or a JSON consumed by it) so the frontend/indexer can
 * read them without manual editing.
 */
export const DEPLOYMENTS: Record<
  SupportedChainId,
  {
    /** ETX governance/rewards token (EticaHub's own ERC20). */
    etx: Address;
    /** Wrapped EGAZ (WEGAZ) — the WETH analog on Etica. */
    wegaz: Address;
    /** EticaSwap V2 factory. */
    swapFactory: Address;
    /** EticaSwap V2 router. */
    swapRouter: Address;
    /** Research Hub subscription contract (Phase 2). */
    researchSubscription: Address;
    /**
     * Permit2 (Uniswap Labs) — canonical address is identical across chains.
     * Deployed via `script/DeployPermit2.s.sol`. Zero until deploy lands on-chain.
     */
    permit2: Address;
    /**
     * UniswapX DutchOrderReactor forked verbatim, owner == treasury initially.
     * Zero until deploy lands on-chain.
     */
    dutchReactor: Address;
    /**
     * ETX-denominated ProtocolFeeController for the reactor. Zero until
     * deploy lands on-chain; reactor runs fee-free until the owner wires it in.
     */
    etxFeeController: Address;
    /**
     * Permissionless on-chain OrderRegistry: swappers post signed orders as
     * events; keepers discover them via log subscription. Replaces the need
     * for a hosted off-chain orderbook HTTP service. Zero until deploy lands.
     */
    orderRegistry: Address;
    /**
     * stETX — ERC-4626 liquid staking token for ETX. Deposit ETX, receive
     * stETX shares whose exchange rate monotonically grows as the keeper
     * harvests treasury LP fees and calls {distributeRewards}. Zero until
     * deploy lands on-chain.
     */
    stakedETX: Address;
    /**
     * TreasuryHarvester — on-chain delegation contract that runs the full
     * harvest pipeline (burn LP → swap to ETX → split across stETX / farms
     * / POL burn / treasury) in a single call. The treasury pre-approves
     * LP + ETX allowances to this address once; {harvest} is permissionless
     * on-chain and is bounded by {maxBurnBpsPerRun} + {harvestCooldown}
     * so the protocol stays live even if every operator disappears.
     */
    treasuryHarvester: Address;
    /**
     * ETXFarms — MasterChef-style LP staking contract. Receives the 10%
     * "farms" slice of every harvest cycle via
     * {distributeRewards(uint256)} and splits it pro-rata across staked
     * LP pools (stETX/ETX, EGAZ/ETX, ETI/ETX). No emissions — the contract only
     * redistributes ETX pushed in by the Harvester. Zero until deploy
     * lands on-chain.
     */
    etxFarms: Address;
    /**
     * EticaStableSwap — rate-aware Curve-style AMM specialised for the
     * stETX/ETX pair. Reads `stETX.convertToAssets(1e18)` live so the peg
     * permanently tracks NAV. ERC-20 LP shares ("esLP"). Zero until deploy
     * lands on-chain.
     */
    eticaStableSwap: Address;
    /**
     * LiquidityTimelock10y — 10-year lock for the treasury's seed esLP
     * shares ONLY. Public LPs hold their shares directly and are not locked.
     * Fees never enter this contract; rescue lets the owner sweep
     * non-locked tokens at any time. Zero until deploy lands on-chain.
     */
    liquidityTimelock10y: Address;
    /**
     * StableSwapHarvesterAdapter — permissionless harvest crank that pulls
     * admin fees from EticaStableSwap, redeems the stETX leg into ETX, and
     * splits the resulting ETX 10/10/40/40 (staked / farms / POL / treasury).
     * Zero until deploy lands on-chain.
     */
    stableSwapHarvesterAdapter: Address;
    /**
     * EticaResearchMarkets — singleton bonding-curve router for research
     * tokens. Holds the shared 5M ETX research pool and is the sole
     * mint/burn authority for every {@link ResearchToken} it launches.
     * Constant-product bonding curve per market, 1% trade fee routed
     * 80/10/0/10 (pool / etiLpSink / treasury / researcher) — the
     * C-with-lock split: the 80% pool slice is permanently non-withdrawable
     * locked POL that monotonically pulls every market's floor up with
     * use. UI-only graduation at 100k ETX reserve, UI-only sunset after
     * 30d of no trades. Zero until deploy lands on-chain.
     */
    eticaResearchMarkets: Address;
    /**
     * EticaResearchNFTMetadata — pure on-chain SVG + JSON tokenURI builder.
     * Deployed once and linked into {@link eticaResearchNft} at compile time;
     * extracted to a separate runtime contract so the NFT stays under the
     * 24,576-byte EIP-170 limit. Zero state, zero authority, zero ETH. Zero
     * until deploy lands on-chain.
     */
    eticaResearchNftMetadataLib: Address;
    /**
     * EticaResearchNFT — immutable ERC-721 minted once per published research
     * candidate (RES). Every mint and every secondary-sale royalty splits
     * 79% current holder / 20% ancestors (geometric 80/20, depth-25 cap) /
     * 1% treasury, uniformly. Reverting ancestor wallets fall through to the
     * current holder. Per-token CREATE2 royalty splitter holds and releases
     * EGAZ + any ERC-20 royalty payments. Single immutable ATTESTOR signs
     * ClaimPayloads; cannot transfer, freeze, or revoke any NFT. Zero until
     * deploy lands on-chain.
     */
    eticaResearchNft: Address;
  }
> = {
  61803: {
    etx: '0xa5A1Bc6307b0b87989B8456D4b35F88a68650044',
    wegaz: '0x232fb2B87CAce92B2438054A7eB79B4081E3E11a',
    swapFactory: '0xfc8dE5A5087c8825AA54E2C57B3FFe0e23784bc3',
    swapRouter: '0xaefbf3fB975657a4C71ea0Fb644B4afE5F555723',
    researchSubscription: '0x0000000000000000000000000000000000000000',
    permit2: '0x165F71f549415f44883e370Df12169Dd99570eE5',
    dutchReactor: '0xE2fc7EAcEB0146560bfcf46CC5B167df60E970B8',
    etxFeeController: '0xB9a4FbfC4cA598Be18e09bb9C0Cf19e4a1A4350a',
    orderRegistry: '0xA6f3e48Cf31DcE3a8d36659f5bC6a61785c404a9',
    stakedETX: '0x75d81d03a98CD9195593b8963aF17E13fAa70334',
    treasuryHarvester: '0x5d8B1138559fADc3Bb90e8317eB16922eAa076f5',
    etxFarms: '0xEBAfdd24ABF8290f0B433E689631466ABD13c6aD',
    eticaStableSwap: '0xbbf5814C1EA0531Cb07541b80c547ee7878C036E',
    liquidityTimelock10y: '0xFdf919673570Cea9c513461604450D003716d739',
    stableSwapHarvesterAdapter: '0x9Adc6298EFDcc1604CB95DaaB33331f866DDBe76',
    eticaResearchMarkets: '0x6605d2F6A8b77a8dC7f53Fd1EDe0974d85937D17',
    eticaResearchNftMetadataLib: '0x0000000000000000000000000000000000000000',
    eticaResearchNft: '0x0000000000000000000000000000000000000000',
  },
  61888: {
    etx: '0x0000000000000000000000000000000000000000',
    wegaz: '0x0000000000000000000000000000000000000000',
    swapFactory: '0x0000000000000000000000000000000000000000',
    swapRouter: '0x0000000000000000000000000000000000000000',
    researchSubscription: '0x0000000000000000000000000000000000000000',
    permit2: '0x0000000000000000000000000000000000000000',
    dutchReactor: '0x0000000000000000000000000000000000000000',
    etxFeeController: '0x0000000000000000000000000000000000000000',
    orderRegistry: '0x0000000000000000000000000000000000000000',
    stakedETX: '0x0000000000000000000000000000000000000000',
    treasuryHarvester: '0x0000000000000000000000000000000000000000',
    etxFarms: '0x0000000000000000000000000000000000000000',
    eticaStableSwap: '0x0000000000000000000000000000000000000000',
    liquidityTimelock10y: '0x0000000000000000000000000000000000000000',
    stableSwapHarvesterAdapter: '0x0000000000000000000000000000000000000000',
    eticaResearchMarkets: '0x0000000000000000000000000000000000000000',
    eticaResearchNftMetadataLib: '0x0000000000000000000000000000000000000000',
    eticaResearchNft: '0x0000000000000000000000000000000000000000',
  },
  31337: {
    // Written by `DeploySwap.s.sol` against the local anvil fork.
    etx: '0x0000000000000000000000000000000000000000',
    wegaz: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    swapFactory: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
    swapRouter: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
    researchSubscription: '0x0000000000000000000000000000000000000000',
    permit2: '0x0000000000000000000000000000000000000000',
    dutchReactor: '0x0000000000000000000000000000000000000000',
    etxFeeController: '0x0000000000000000000000000000000000000000',
    orderRegistry: '0x0000000000000000000000000000000000000000',
    stakedETX: '0x0000000000000000000000000000000000000000',
    treasuryHarvester: '0x0000000000000000000000000000000000000000',
    etxFarms: '0x0000000000000000000000000000000000000000',
    eticaStableSwap: '0x0000000000000000000000000000000000000000',
    liquidityTimelock10y: '0x0000000000000000000000000000000000000000',
    stableSwapHarvesterAdapter: '0x0000000000000000000000000000000000000000',
    eticaResearchMarkets: '0x0000000000000000000000000000000000000000',
    eticaResearchNftMetadataLib: '0x0000000000000000000000000000000000000000',
    eticaResearchNft: '0x0000000000000000000000000000000000000000',
  },
};

/** Treasury / admin wallet — owner of factory and fee recipient. */
export const TREASURY_ADDRESS: Address = '0xB2B4bC9d02970A55efF64C2D84c622c87967C19D';

/**
 * Phase 3 ETX bridge — deployed addresses per chain.
 *
 * Source-of-truth contracts live on Etica ({@link BRIDGE_ETICA_DEPLOYMENT}) and
 * are mirrored on each remote chain (Ethereum mainnet, BNB Smart Chain) via
 * {@link BRIDGE_REMOTE_DEPLOYMENTS}. Until each address is filled in here,
 * the bridge UI renders read-only "launching soon" cards and skip-cleans
 * any write attempt. After the live deploy lands, replace each
 * `0x000…000` with the broadcast address — no UI code changes needed.
 *
 * See `docs/BRIDGE_DEPLOY_WALKTHROUGH.md` for the deploy ordering.
 */
export const BRIDGE_ETICA_DEPLOYMENT = {
  bridgeVault: '0x0000000000000000000000000000000000000000' as Address,
  bridgeInsuranceFund: '0x0000000000000000000000000000000000000000' as Address,
  feeRouter: '0x0000000000000000000000000000000000000000' as Address,
  insuranceTopUpReceiver: '0x0000000000000000000000000000000000000000' as Address,
} as const;

/**
 * One entry per remote chain that the bridge mints wETX on. Chain ID
 * matches the Hyperlane domain ID (Ethereum=1, BNB=56) so a single key
 * covers both wagmi/viem and Hyperlane addressing.
 */
export const BRIDGE_REMOTE_DEPLOYMENTS = {
  /** Ethereum mainnet — Hyperlane domain 1. */
  1: {
    chainName: 'Ethereum',
    bridgeMinter: '0x0000000000000000000000000000000000000000' as Address,
    wrappedEtx: '0x0000000000000000000000000000000000000000' as Address,
    optimisticVetoModule: '0x0000000000000000000000000000000000000000' as Address,
    fraudProverModule: '0x0000000000000000000000000000000000000000' as Address,
    heartbeatIsm: '0x0000000000000000000000000000000000000000' as Address,
    tvlCapIsm: '0x0000000000000000000000000000000000000000' as Address,
    rateLimitIsm: '0x0000000000000000000000000000000000000000' as Address,
    explorerUrl: 'https://etherscan.io',
  },
  /** BNB Smart Chain — Hyperlane domain 56. */
  56: {
    chainName: 'BNB Smart Chain',
    bridgeMinter: '0x0000000000000000000000000000000000000000' as Address,
    wrappedEtx: '0x0000000000000000000000000000000000000000' as Address,
    optimisticVetoModule: '0x0000000000000000000000000000000000000000' as Address,
    fraudProverModule: '0x0000000000000000000000000000000000000000' as Address,
    heartbeatIsm: '0x0000000000000000000000000000000000000000' as Address,
    tvlCapIsm: '0x0000000000000000000000000000000000000000' as Address,
    rateLimitIsm: '0x0000000000000000000000000000000000000000' as Address,
    explorerUrl: 'https://bscscan.com',
  },
} as const;

export type BridgeRemoteDomain = keyof typeof BRIDGE_REMOTE_DEPLOYMENTS;

/**
 * @returns true once any Etica-side core address has been filled in. The
 * bridge UI uses this as the master "is this live?" toggle.
 */
export function isBridgeLive(): boolean {
  const z = '0x0000000000000000000000000000000000000000';
  return BRIDGE_ETICA_DEPLOYMENT.bridgeVault !== z;
}

/**
 * @returns true if the given remote chain's minter has been deployed.
 */
export function isBridgeRemoteLive(domain: BridgeRemoteDomain): boolean {
  const z = '0x0000000000000000000000000000000000000000';
  return BRIDGE_REMOTE_DEPLOYMENTS[domain].bridgeMinter !== z;
}
