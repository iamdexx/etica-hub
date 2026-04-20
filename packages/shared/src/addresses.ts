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
    /** Wrapped EGAZ (WEGAZ) — the WETH analog on Etica. */
    wegaz: Address;
    /** EticaSwap V2 factory. */
    swapFactory: Address;
    /** EticaSwap V2 router. */
    swapRouter: Address;
  }
> = {
  61803: {
    wegaz: '0x0000000000000000000000000000000000000000',
    swapFactory: '0x0000000000000000000000000000000000000000',
    swapRouter: '0x0000000000000000000000000000000000000000',
  },
  61888: {
    wegaz: '0x0000000000000000000000000000000000000000',
    swapFactory: '0x0000000000000000000000000000000000000000',
    swapRouter: '0x0000000000000000000000000000000000000000',
  },
};

/** Treasury / admin wallet — owner of factory and fee recipient. */
export const TREASURY_ADDRESS: Address = '0xB2B4bC9d02970A55efF64C2D84c622c87967C19D';
