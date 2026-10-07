import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { toHex } from 'viem';
import {
  BRIDGE_DEPLOY_DOMAIN,
  BRIDGE_DEPLOY_PRIMARY_TYPE,
  BRIDGE_DEPLOY_TYPES,
  DEPLOY_CONFIRM_PHRASE,
  parseDeployMessage,
  toDeployMessageJson,
  type BridgeDeployMessage,
} from '@/lib/bridge-deploy/typed-data';
import {
  burnDeploySignature,
  parseCoreAddresses,
  parseWarpRouters,
  verifyDeployAuthorization,
} from '@/lib/bridge-deploy/server';
import { memoryKv } from '@/lib/buybot/state';
import { BRIDGE_ROLES } from '@etica-hub/shared';

const signer = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const NOW = 1_800_000_000;

function message(over: Partial<BridgeDeployMessage> = {}): BridgeDeployMessage {
  return {
    step: 'all',
    owner: BRIDGE_ROLES.owner,
    validator: BRIDGE_ROLES.validator,
    guardian: BRIDGE_ROLES.guardian,
    confirm: DEPLOY_CONFIRM_PHRASE,
    nonce: toHex(new Uint8Array(32).fill(7)),
    deadline: BigInt(NOW + 300),
    ...over,
  };
}

async function sign(m: BridgeDeployMessage) {
  return signer.signTypedData({
    domain: BRIDGE_DEPLOY_DOMAIN,
    types: BRIDGE_DEPLOY_TYPES,
    primaryType: BRIDGE_DEPLOY_PRIMARY_TYPE,
    message: m,
  });
}

describe('parseDeployMessage', () => {
  it('round-trips the JSON the browser sends', () => {
    const m = message();
    const parsed = parseDeployMessage(toDeployMessageJson(m));
    expect(parsed).toEqual({ ok: true, message: m });
  });

  it('rejects the keeper in any owned role', () => {
    const r = parseDeployMessage(toDeployMessageJson(message({ owner: BRIDGE_ROLES.keeper })));
    expect(r).toEqual({ ok: false, error: 'owner must not be the keeper' });
  });

  it('rejects owner == validator, bad steps and bad confirm phrases', () => {
    expect(parseDeployMessage(toDeployMessageJson(message({ validator: BRIDGE_ROLES.owner }))).ok).toBe(false);
    expect(parseDeployMessage({ ...toDeployMessageJson(message()), step: 'nuke' }).ok).toBe(false);
    expect(parseDeployMessage({ ...toDeployMessageJson(message()), confirm: 'deploy-mainnet' }).ok).toBe(false);
    expect(parseDeployMessage({ ...toDeployMessageJson(message()), confirm: '' }).ok).toBe(true);
  });
});

describe('verifyDeployAuthorization', () => {
  it('accepts a fresh signature from the configured signer', async () => {
    const m = message();
    const sig = await sign(m);
    expect(await verifyDeployAuthorization(m, sig, { nowSeconds: NOW, signer: signer.address })).toEqual({ ok: true });
  });

  it('rejects other signers, expired deadlines and tampered fields', async () => {
    const m = message();
    const sig = await sign(m);
    expect((await verifyDeployAuthorization(m, sig, { nowSeconds: NOW })).ok).toBe(false);
    expect((await verifyDeployAuthorization(m, sig, { nowSeconds: NOW + 301, signer: signer.address })).ok).toBe(false);
    expect(
      (await verifyDeployAuthorization({ ...m, confirm: '' }, sig, { nowSeconds: NOW, signer: signer.address })).ok,
    ).toBe(false);
    expect(
      (await verifyDeployAuthorization(message({ deadline: BigInt(NOW + 100_000) }), sig, {
        nowSeconds: NOW,
        signer: signer.address,
      })).ok,
    ).toBe(false);
  });

  it('burns a signature exactly once', async () => {
    const store = memoryKv();
    const sig = await sign(message());
    expect(await burnDeploySignature(store, sig)).toBe(true);
    expect(await burnDeploySignature(store, sig)).toBe(false);
  });
});

describe('registry parsing', () => {
  it('reads the flat core addresses file', () => {
    const core = parseCoreAddresses(
      'mailbox: "0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e"\nproxyAdmin: 0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6\nnotAnAddress: hello\n',
    );
    expect(core).toEqual({
      mailbox: '0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e',
      proxyAdmin: '0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6',
    });
  });

  it('picks the router per chain out of the warp config token list', () => {
    const yaml = [
      'tokens:',
      '  - addressOrDenom: "0x1111111111111111111111111111111111111111"',
      '    chainName: ethereum',
      '    collateralAddressOrDenom: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"',
      '    standard: EvmHypCollateral',
      '  - addressOrDenom: "0x2222222222222222222222222222222222222222"',
      '    chainName: etica',
      '    standard: EvmHypSynthetic',
      '',
    ].join('\n');
    expect(parseWarpRouters(yaml)).toEqual({
      ethereum: '0x1111111111111111111111111111111111111111',
      etica: '0x2222222222222222222222222222222222222222',
    });
  });
});
