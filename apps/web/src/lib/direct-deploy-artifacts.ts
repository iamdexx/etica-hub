import type { Abi, Hex } from 'viem';
import artifacts from './direct-deploy-artifacts.json';

type Artifact = { abi: Abi; bytecode: Hex };

const cast = (a: unknown): Artifact => {
  const x = a as { abi: Abi; bytecode: string };
  return { abi: x.abi, bytecode: x.bytecode as Hex };
};

export const directFactoryArtifact = cast(artifacts.directFactory);
export const directRouterArtifact = cast(artifacts.directRouter);
export const directHarvesterAdapterArtifact = cast(artifacts.directHarvesterAdapter);
export const directMetaPairDeployerArtifact = cast(artifacts.directMetaPairDeployer);
export const directMetaPairArtifact = cast(artifacts.directMetaPair);
export const unanimousMultisigArtifact = cast(artifacts.unanimousMultisig);
