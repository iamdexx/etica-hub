import type { Abi, Hex } from 'viem';
import artifacts from './trading-deploy-artifacts.json';

type Artifact = { abi: Abi; bytecode: Hex };

const cast = (a: unknown): Artifact => {
  const x = a as { abi: Abi; bytecode: string };
  return { abi: x.abi, bytecode: x.bytecode as Hex };
};

/**
 * Compiled artifacts for the non-custodial trading stack.
 *
 * - `permit2Artifact`       — Uniswap Labs Permit2 (verbatim, solc 0.8.17, via_ir).
 *                             Audited by OpenZeppelin, ABDK, and Trail of Bits.
 * - `reactorArtifact`       — UniswapX DutchOrderReactor (verbatim, solc 0.8.29).
 *                             Audited upstream.
 * - `feeControllerArtifact` — EticaHub's EticaProtocolFeeController (ours, solc 0.8.29).
 *                             ETX-denominated, 1% hard cap, owner-gated.
 *
 * Rebuild instructions: see packages/trading-contracts/script/extract-deploy-artifacts.mjs.
 */
export const permit2Artifact = cast(artifacts.permit2);
export const reactorArtifact = cast(artifacts.reactor);
export const feeControllerArtifact = cast(artifacts.feeController);
