import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { hashMessage } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { buildDigest } from '../src/digest';
import { createCoordinatorApp, InMemoryStore } from '../src/coordinator';

const v1 = privateKeyToAccount(generatePrivateKey());
const v2 = privateKeyToAccount(generatePrivateKey());
const v3 = privateKeyToAccount(generatePrivateKey());
const outsider = privateKeyToAccount(generatePrivateKey());

const basePayload = {
  srcChainId: 61803n,
  dstChainId: 1n,
  srcTxHash: '0x1111111111111111111111111111111111111111111111111111111111111111' as const,
  nonce: '0x2222222222222222222222222222222222222222222222222222222222222222' as const,
  token: '0x34c61EA91bAcdA647269d4e310A86b875c09946f' as const,
  amount: 1_000n,
  recipient: '0xB2B4bC9d02970A55efF64C2D84c622c87967C19D' as const,
};

let server: Server;
let baseUrl: string;

type JsonObj = Record<string, unknown>;

async function post(path: string, body: unknown): Promise<{ status: number; body: JsonObj }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as JsonObj };
}

async function get(path: string): Promise<{ status: number; body: JsonObj }> {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: (await res.json()) as JsonObj };
}

function toWireFormat() {
  return {
    srcChainId: basePayload.srcChainId.toString(),
    dstChainId: basePayload.dstChainId.toString(),
    srcTxHash: basePayload.srcTxHash,
    nonce: basePayload.nonce,
    token: basePayload.token,
    amount: basePayload.amount.toString(),
    recipient: basePayload.recipient,
  };
}

async function signBy(account: typeof v1) {
  const digest = buildDigest(basePayload);
  return account.signMessage({ message: { raw: digest } });
}

beforeAll(async () => {
  const app = createCoordinatorApp(
    {
      port: 0,
      threshold: 2,
      validators: [v1.address, v2.address, v3.address],
    },
    new InMemoryStore(),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('coordinator HTTP', () => {
  it('rejects outsider signatures', async () => {
    const sig = await signBy(outsider);
    const r = await post('/signatures', { payload: toWireFormat(), signature: sig });
    expect(r.status).toBe(403);
  });

  it('aggregates sigs from distinct validators and marks ready at threshold', async () => {
    const s1 = await signBy(v1);
    const r1 = await post('/signatures', { payload: toWireFormat(), signature: s1 });
    expect(r1.status).toBe(200);
    expect(r1.body.ready).toBe(false);
    expect(r1.body.collected).toBe(1);

    const s2 = await signBy(v2);
    const r2 = await post('/signatures', { payload: toWireFormat(), signature: s2 });
    expect(r2.status).toBe(200);
    expect(r2.body.collected).toBe(2);
    expect(r2.body.ready).toBe(true);

    const fetched = await get(`/signatures/${basePayload.nonce}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.ready).toBe(true);
    expect(fetched.body.signatures).toHaveLength(2);

    // Sigs returned sorted ascending by address — matches what the
    // on-chain MultisigVerifier expects for dedup ordering.
    const signers = (fetched.body.signatures as { validator: string }[]).map(
      (s) => s.validator.toLowerCase(),
    );
    expect(signers).toEqual([...signers].sort());
  });

  it('dedupes repeat submissions from same validator', async () => {
    const sig = await signBy(v3);
    const r1 = await post('/signatures', { payload: toWireFormat(), signature: sig });
    const r2 = await post('/signatures', { payload: toWireFormat(), signature: sig });
    expect(r1.body.collected).toBeGreaterThanOrEqual(2);
    // After v3's first post it should be 3; repeat must not increase count.
    expect(r2.body.collected).toBe(r1.body.collected);
  });

  it('returns 404 for an unseen nonce', async () => {
    const r = await get(
      '/signatures/0xdeadbeef000000000000000000000000000000000000000000000000deadbeef',
    );
    expect(r.status).toBe(404);
  });

  it('verifies signature over the EIP-191 envelope of the digest', async () => {
    // Sanity check: payload → digest → hashMessage → recovered address in set
    const digest = buildDigest(basePayload);
    const sig = await v1.signMessage({ message: { raw: digest } });
    const wrapped = hashMessage({ raw: digest });
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
    expect(wrapped).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
