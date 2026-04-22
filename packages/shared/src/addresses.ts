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
    stakedETX: '0x0000000000000000000000000000000000000000',
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
  },
};

/** Treasury / admin wallet — owner of factory and fee recipient. */
export const TREASURY_ADDRESS: Address = '0xB2B4bC9d02970A55efF64C2D84c622c87967C19D';
