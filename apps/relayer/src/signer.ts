import {
  createPublicClient,
  http,
  parseAbiItem,
  defineChain,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { loadSignerConfig, type SignerConfig } from './config';
import { buildDigest, type AttestationPayload } from './digest';

/**
 * Per-validator process: watches the source contract for the relevant event,
 * signs the canonical digest with an EIP-191 personal_sign, and posts the
 * payload + signature to the coordinator. Idempotent — if the coordinator
 * already has a signature for the nonce from this validator it returns 200
 * unchanged.
 *
 * One signer process per direction per validator (so a full 2-of-3 setup
 * runs 6 signer processes total; operators can collocate them).
 */

const depositedEvent = parseAbiItem(
  'event Deposited(bytes32 indexed nonce, address indexed sender, uint256 amount, address recipient)',
);
const burnedEvent = parseAbiItem(
  'event Burned(bytes32 indexed nonce, address indexed sender, uint256 amount, address recipient)',
);

function makeChain(chainId: number, rpcUrl: string) {
  return defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: 'native', symbol: 'NAT', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

interface RelevantEvent {
  nonce: Hex;
  amount: bigint;
  recipient: Address;
  txHash: Hex;
  blockNumber: bigint;
}

async function postSignature(
  coordinatorUrl: string,
  payload: AttestationPayload,
  signature: Hex,
): Promise<void> {
  const body = {
    payload: {
      srcChainId: payload.srcChainId.toString(),
      dstChainId: payload.dstChainId.toString(),
      srcTxHash: payload.srcTxHash,
      nonce: payload.nonce,
      token: payload.token,
      amount: payload.amount.toString(),
      recipient: payload.recipient,
    },
    signature,
  };
  const res = await fetch(`${coordinatorUrl}/signatures`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `coordinator POST /signatures failed: ${res.status} ${await res.text()}`,
    );
  }
}

export async function signAndPost(
  cfg: SignerConfig,
  ev: RelevantEvent,
): Promise<{ digest: Hex; signature: Hex }> {
  const account = privateKeyToAccount(cfg.validatorPrivateKey);
  const payload: AttestationPayload = {
    srcChainId: BigInt(cfg.source.chainId),
    dstChainId: BigInt(cfg.dest.chainId),
    srcTxHash: ev.txHash,
    nonce: ev.nonce,
    token: cfg.token,
    amount: ev.amount,
    recipient: ev.recipient,
  };
  const digest = buildDigest(payload);
  // viem wraps the digest in the EIP-191 envelope when `raw` is passed.
  const signature = await account.signMessage({ message: { raw: digest } });
  await postSignature(cfg.coordinatorUrl, payload, signature);
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: 'signer.posted',
      validator: account.address,
      nonce: ev.nonce,
      txHash: ev.txHash,
    }),
  );
  return { digest, signature };
}

export async function runSigner(cfg: SignerConfig = loadSignerConfig()): Promise<void> {
  const account = privateKeyToAccount(cfg.validatorPrivateKey);
  const client = createPublicClient({
    chain: makeChain(cfg.source.chainId, cfg.source.rpcUrl),
    transport: http(cfg.source.rpcUrl),
  }) as PublicClient;

  const eventAbi = cfg.direction === 'etica-to-eth' ? depositedEvent : burnedEvent;
  const seen = new Set<Hex>();
  let fromBlock = cfg.startBlock ?? (await client.getBlockNumber());

  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: 'signer.boot',
      validator: account.address,
      direction: cfg.direction,
      src: cfg.source,
      dst: cfg.dest,
      fromBlock: fromBlock.toString(),
      coordinator: cfg.coordinatorUrl,
    }),
  );

  // Simple polling loop. Production would use viem's `watchEvent` + a
  // persistence layer; poll is sufficient for MVP and avoids WS reliability
  // concerns on the Etica RPC.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const tip = await client.getBlockNumber();
      if (tip >= fromBlock) {
        const logs = await client.getLogs({
          address: cfg.source.contract,
          event: eventAbi,
          fromBlock,
          toBlock: tip,
        });
        for (const log of logs) {
          const nonce = log.args.nonce as Hex;
          if (seen.has(nonce)) continue;
          const amount = log.args.amount as bigint;
          const recipient = log.args.recipient as Address;
          await signAndPost(cfg, {
            nonce,
            amount,
            recipient,
            txHash: log.transactionHash!,
            blockNumber: log.blockNumber!,
          });
          seen.add(nonce);
        }
        fromBlock = tip + 1n;
      }
    } catch (err) {
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: 'signer.error',
          error: (err as Error).message,
        }),
      );
    }
    await new Promise((r) => setTimeout(r, cfg.pollIntervalMs));
  }
}
