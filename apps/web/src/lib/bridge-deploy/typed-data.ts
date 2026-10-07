/**
 * EIP-712 authorisation for the USDC.e Hyperlane route mainnet deploy.
 *
 * The keeper key never leaves the GitHub `harvest-live` environment, so the
 * /deploy/bridge page cannot sign the ~45 deploy transactions itself. The
 * keeper *wallet* signs one `BridgeDeploy` message in the browser instead;
 * the server recovers the signer, checks it is the keeper, burns the nonce
 * and dispatches `.github/workflows/bridge-deploy.yml`, which runs the
 * fork-tested `infra/hyperlane/deploy.sh` with the same key.
 *
 * Client-safe: no node-only imports.
 */
import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { BRIDGE_ROLES, eticaMainnet } from '@etica-hub/shared';

export const BRIDGE_DEPLOY_STEPS = ['core', 'warp', 'agent-config', 'all'] as const;
export type BridgeDeployStep = (typeof BRIDGE_DEPLOY_STEPS)[number];

/** Must match the `confirm` input the workflow gates the real deploy on. */
export const DEPLOY_CONFIRM_PHRASE = 'DEPLOY-MAINNET';

/** Signed requests may not be dated further ahead than this. */
export const DEPLOY_SIGNATURE_TTL_SECONDS = 600;

export const BRIDGE_DEPLOY_DOMAIN = {
  name: 'EticaHub Bridge Deploy',
  version: '1',
  chainId: eticaMainnet.id,
} as const;

export const BRIDGE_DEPLOY_TYPES = {
  BridgeDeploy: [
    { name: 'step', type: 'string' },
    { name: 'owner', type: 'address' },
    { name: 'validator', type: 'address' },
    { name: 'guardian', type: 'address' },
    { name: 'confirm', type: 'string' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

export const BRIDGE_DEPLOY_PRIMARY_TYPE = 'BridgeDeploy' as const;

export interface BridgeDeployMessage {
  step: BridgeDeployStep;
  owner: Address;
  validator: Address;
  guardian: Address;
  /** '' = pre-flight only; DEPLOY_CONFIRM_PHRASE = broadcast on mainnet. */
  confirm: '' | typeof DEPLOY_CONFIRM_PHRASE;
  nonce: Hex;
  deadline: bigint;
}

/** JSON shape sent by the browser (`deadline` as a decimal string). */
export interface BridgeDeployMessageJson {
  step: string;
  owner: string;
  validator: string;
  guardian: string;
  confirm: string;
  nonce: string;
  deadline: string;
}

export type ParseDeployMessageResult =
  | { ok: true; message: BridgeDeployMessage }
  | { ok: false; error: string };

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Validates an untrusted request body into a {@link BridgeDeployMessage}.
 * Enforces the same role rules as `infra/hyperlane/deploy.sh` so a bad
 * request is rejected before a workflow run is spent on it.
 */
export function parseDeployMessage(
  body: unknown,
  keeper: Address = BRIDGE_ROLES.keeper,
): ParseDeployMessageResult {
  if (!body || typeof body !== 'object') return { ok: false, error: 'message must be an object' };
  const m = body as Record<string, unknown>;

  const step = m.step;
  if (typeof step !== 'string' || !(BRIDGE_DEPLOY_STEPS as readonly string[]).includes(step)) {
    return { ok: false, error: `step must be one of ${BRIDGE_DEPLOY_STEPS.join(', ')}` };
  }

  const roles: Partial<Record<'owner' | 'validator' | 'guardian', Address>> = {};
  for (const key of ['owner', 'validator', 'guardian'] as const) {
    const v = m[key];
    if (typeof v !== 'string' || !isAddress(v)) return { ok: false, error: `${key} is not an address` };
    if (sameAddress(v, keeper)) return { ok: false, error: `${key} must not be the keeper` };
    roles[key] = getAddress(v);
  }
  if (sameAddress(roles.owner!, roles.validator!)) {
    return { ok: false, error: 'owner and validator must differ' };
  }

  const confirm = m.confirm;
  if (confirm !== '' && confirm !== DEPLOY_CONFIRM_PHRASE) {
    return { ok: false, error: `confirm must be empty or ${DEPLOY_CONFIRM_PHRASE}` };
  }

  const nonce = m.nonce;
  if (typeof nonce !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(nonce)) {
    return { ok: false, error: 'nonce must be a bytes32 hex string' };
  }

  const deadlineRaw = m.deadline;
  const deadlineStr =
    typeof deadlineRaw === 'number' ? String(deadlineRaw) : typeof deadlineRaw === 'string' ? deadlineRaw : '';
  if (!/^\d{1,12}$/.test(deadlineStr)) return { ok: false, error: 'deadline must be a unix timestamp' };

  return {
    ok: true,
    message: {
      step: step as BridgeDeployStep,
      owner: roles.owner!,
      validator: roles.validator!,
      guardian: roles.guardian!,
      confirm: confirm as '' | typeof DEPLOY_CONFIRM_PHRASE,
      nonce: nonce as Hex,
      deadline: BigInt(deadlineStr),
    },
  };
}

export function toDeployMessageJson(m: BridgeDeployMessage): BridgeDeployMessageJson {
  return { ...m, deadline: m.deadline.toString() };
}
