import 'dotenv/config';
import { type Address, type Hex, isAddress, isHex } from 'viem';

export type BridgeDirection = 'etica-to-eth' | 'eth-to-etica';

export interface ChainEndpoint {
  chainId: number;
  rpcUrl: string;
  contract: Address; // vault on Etica-side, minter on Ethereum-side
}

export interface SignerConfig {
  validatorPrivateKey: Hex;
  coordinatorUrl: string;
  source: ChainEndpoint;
  dest: ChainEndpoint;
  direction: BridgeDirection;
  token: Address;
  startBlock?: bigint;
  pollIntervalMs: number;
}

export interface CoordinatorConfig {
  port: number;
  /** Required threshold of distinct validator signatures. */
  threshold: number;
  /** Allowlist of validator addresses whose sigs will be accepted. */
  validators: Address[];
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env: ${name}`);
  return v;
}

function asAddress(name: string, v: string): Address {
  if (!isAddress(v)) throw new Error(`${name} is not an address: ${v}`);
  return v;
}

function asHex(name: string, v: string): Hex {
  if (!isHex(v)) throw new Error(`${name} is not hex: ${v}`);
  return v;
}

export function loadSignerConfig(): SignerConfig {
  const direction = req('RELAYER_DIRECTION') as BridgeDirection;
  if (direction !== 'etica-to-eth' && direction !== 'eth-to-etica') {
    throw new Error(`RELAYER_DIRECTION must be etica-to-eth or eth-to-etica`);
  }
  const source: ChainEndpoint = {
    chainId: Number(req('RELAYER_SRC_CHAIN_ID')),
    rpcUrl: req('RELAYER_SRC_RPC_URL'),
    contract: asAddress('RELAYER_SRC_CONTRACT', req('RELAYER_SRC_CONTRACT')),
  };
  const dest: ChainEndpoint = {
    chainId: Number(req('RELAYER_DST_CHAIN_ID')),
    rpcUrl: req('RELAYER_DST_RPC_URL'),
    contract: asAddress('RELAYER_DST_CONTRACT', req('RELAYER_DST_CONTRACT')),
  };
  const startBlock = process.env.RELAYER_START_BLOCK
    ? BigInt(process.env.RELAYER_START_BLOCK)
    : undefined;

  return {
    validatorPrivateKey: asHex('VALIDATOR_PRIVATE_KEY', req('VALIDATOR_PRIVATE_KEY')),
    coordinatorUrl: req('COORDINATOR_URL'),
    source,
    dest,
    direction,
    token: asAddress('RELAYER_TOKEN', req('RELAYER_TOKEN')),
    startBlock,
    pollIntervalMs: Number(process.env.RELAYER_POLL_MS ?? '8000'),
  };
}

export function loadCoordinatorConfig(): CoordinatorConfig {
  const rawValidators = req('COORDINATOR_VALIDATORS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const validators = rawValidators.map((v) => asAddress('COORDINATOR_VALIDATORS', v));
  const threshold = Number(process.env.COORDINATOR_THRESHOLD ?? '2');
  if (threshold < 1) throw new Error('threshold must be >= 1');
  if (threshold > validators.length) {
    throw new Error(
      `threshold (${threshold}) > validator set size (${validators.length})`,
    );
  }
  return {
    port: Number(process.env.COORDINATOR_PORT ?? '4000'),
    threshold,
    validators,
  };
}
