import type { Abi, Hex } from 'viem';
import artifacts from './deploy-artifacts.json';

type Artifact = { abi: Abi; bytecode: Hex };

const cast = (a: unknown): Artifact => {
  const x = a as { abi: Abi; bytecode: string };
  return { abi: x.abi, bytecode: x.bytecode as Hex };
};

export const wegazArtifact = cast(artifacts.wegaz);
export const factoryArtifact = cast(artifacts.factory);
export const routerArtifact = cast(artifacts.router);
