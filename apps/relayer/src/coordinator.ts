import express, { type Request, type Response } from 'express';
import {
  getAddress,
  hashMessage,
  recoverAddress,
  type Address,
  type Hex,
} from 'viem';
import { loadCoordinatorConfig, type CoordinatorConfig } from './config';
import { buildDigest, type AttestationPayload } from './digest';

/**
 * In-memory signature aggregator.
 *
 * - Validators POST `{ payload, signature }` to `/signatures`.
 * - Anyone GETs `/signatures/:nonce` to fetch collected sigs for a nonce.
 *
 * For MVP this process is run by a single trusted operator; validators
 * remain trustless in the protocol sense because the destination contract
 * independently recovers and checks each signature. The coordinator is a
 * convenience layer — if it goes down, operators can exchange sigs
 * out-of-band and still submit on-chain.
 *
 * Production hardening (future): persistence (SQLite/Postgres), rate limits,
 * multi-coordinator replication, and a signed `nonce → payload` record so
 * clients can validate the payload without re-reading source chain.
 */

interface StoredSignature {
  validator: Address;
  signature: Hex;
  receivedAt: string;
}

interface StoredRecord {
  payload: AttestationPayload;
  digest: Hex;
  signatures: Map<Address, StoredSignature>;
}

export class InMemoryStore {
  private readonly records = new Map<Hex, StoredRecord>();

  get(nonce: Hex): StoredRecord | undefined {
    return this.records.get(nonce);
  }

  upsert(
    payload: AttestationPayload,
    digest: Hex,
    validator: Address,
    signature: Hex,
  ): StoredRecord {
    let rec = this.records.get(payload.nonce);
    if (!rec) {
      rec = { payload, digest, signatures: new Map() };
      this.records.set(payload.nonce, rec);
    } else if (rec.digest !== digest) {
      throw new Error(
        `digest mismatch for nonce ${payload.nonce}: ${rec.digest} vs ${digest}`,
      );
    }
    rec.signatures.set(validator, {
      validator,
      signature,
      receivedAt: new Date().toISOString(),
    });
    return rec;
  }
}

export interface SignaturePost {
  payload: {
    srcChainId: string;
    dstChainId: string;
    srcTxHash: Hex;
    nonce: Hex;
    token: Address;
    amount: string;
    recipient: Address;
  };
  signature: Hex;
}

function parsePayload(raw: SignaturePost['payload']): AttestationPayload {
  return {
    srcChainId: BigInt(raw.srcChainId),
    dstChainId: BigInt(raw.dstChainId),
    srcTxHash: raw.srcTxHash,
    nonce: raw.nonce,
    token: getAddress(raw.token),
    amount: BigInt(raw.amount),
    recipient: getAddress(raw.recipient),
  };
}

export function createCoordinatorApp(
  cfg: CoordinatorConfig,
  store: InMemoryStore = new InMemoryStore(),
): express.Express {
  const app = express();
  app.use(express.json({ limit: '32kb' }));

  const allowed = new Set(cfg.validators.map((v) => getAddress(v)));

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      threshold: cfg.threshold,
      validators: [...allowed],
    });
  });

  app.post('/signatures', async (req: Request, res: Response) => {
    try {
      const body = req.body as SignaturePost;
      if (!body?.payload || !body.signature) {
        return res.status(400).json({ error: 'missing payload or signature' });
      }
      const payload = parsePayload(body.payload);
      const digest = buildDigest(payload);
      const ethHash = hashMessage({ raw: digest });
      const signer = getAddress(
        await recoverAddress({ hash: ethHash, signature: body.signature }),
      );
      if (!allowed.has(signer)) {
        return res.status(403).json({ error: `signer ${signer} not in validator set` });
      }
      const rec = store.upsert(payload, digest, signer, body.signature);
      return res.json({
        nonce: payload.nonce,
        digest,
        collected: rec.signatures.size,
        threshold: cfg.threshold,
        ready: rec.signatures.size >= cfg.threshold,
      });
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get('/signatures/:nonce', (req: Request, res: Response) => {
    const nonce = req.params.nonce as Hex;
    const rec = store.get(nonce);
    if (!rec) return res.status(404).json({ error: 'no record for nonce' });
    const sigs = [...rec.signatures.values()].sort((a, b) =>
      a.validator.toLowerCase() < b.validator.toLowerCase() ? -1 : 1,
    );
    return res.json({
      nonce,
      digest: rec.digest,
      payload: {
        srcChainId: rec.payload.srcChainId.toString(),
        dstChainId: rec.payload.dstChainId.toString(),
        srcTxHash: rec.payload.srcTxHash,
        nonce: rec.payload.nonce,
        token: rec.payload.token,
        amount: rec.payload.amount.toString(),
        recipient: rec.payload.recipient,
      },
      signatures: sigs,
      threshold: cfg.threshold,
      ready: sigs.length >= cfg.threshold,
    });
  });

  return app;
}

export function runCoordinator(): void {
  const cfg = loadCoordinatorConfig();
  const app = createCoordinatorApp(cfg);
  app.listen(cfg.port, () => {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'coordinator.boot',
        port: cfg.port,
        threshold: cfg.threshold,
        validators: cfg.validators,
      }),
    );
  });
}
