import type { Metadata } from 'next';
import Link from 'next/link';

import { PageHero } from '@/components/PageHero';
import { CopyBlock } from '@/components/node/CopyBlock';
import { absoluteUrl } from '@/lib/site';

export const revalidate = 60;

export const metadata: Metadata = {
  title: 'Run a node · peer with EticaHub',
  description:
    'EticaHub archive node: public RPC, WebSocket and GraphQL endpoints, our enode, the Etica bootnodes and a one-line peer command.',
  alternates: { canonical: absoluteUrl('/node') },
};

const RPC_HTTP = 'https://rpc.eticahub.com';
const RPC_WS = 'wss://rpc.eticahub.com';
const RPC_GRAPHQL = 'https://rpc.eticahub.com/graphql';

const OUR_ENODE =
  'enode://298d5eee7bb73a5513f1d3716e133144cf0639dbee78de5489533312c4cddee32ffae5fcb1e38e531103ba06f57b58723b4cbb1596d09bce1a6b42ed23e4c602@165.22.225.91:30304';

/** Bootnodes shipped in etica/core-geth params/bootnodes_etica.go plus known community nodes. */
const PEERS: { name: string; enode: string }[] = [
  { name: 'EticaHub archive (this node)', enode: OUR_ENODE },
  {
    name: 'Etica bootnode',
    enode:
      'enode://b0e97d2f1a37b2035a34b97f32fb31ddd93ae822b603c56b7f17cfb189631ea2ef17bfbed904f8bc564765634f2d9db0a128835178c8af9f1dde68ee6b5e2bf7@167.172.47.195:30303',
  },
  {
    name: 'rpc.etica-stats.org',
    enode:
      'enode://8117c728f3a220ab82779633667e9fe03696e9bd3f00f2b3b1e4e9e8bcd0471ecd1f9ff280414c26e5f3b8ec84e1e099e12bea05f43a2e8999007cf3944116c9@62.72.177.111:30305',
  },
  {
    name: 'rpc2.etica-stats.org',
    enode:
      'enode://3c2141dc5e64dcd4924ce7acf53b4f35e296b5f686ede0175bee06844bbcde6690431faa466dbe61db5248114ad9dae7853bd8881f674a34c3867007ba360618@62.72.177.114:30405',
  },
];

const ADD_PEERS_JS = PEERS.map((p) => `admin.addPeer("${p.enode}")`).join('\n');
const STATIC_NODES_JSON = JSON.stringify(PEERS.map((p) => p.enode), null, 2);

interface LiveStats {
  block: number | null;
  peers: number | null;
  /** null = eth_syncing unavailable; false = not syncing (synced). */
  syncing: { current: number; highest: number } | false | null;
  ok: boolean;
}

async function rpc<T>(method: string): Promise<T | null> {
  try {
    const res = await fetch(RPC_HTTP, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { result?: T };
    return json.result ?? null;
  } catch {
    return null;
  }
}

async function loadStats(): Promise<LiveStats> {
  const [block, peers, syncing] = await Promise.all([
    rpc<string>('eth_blockNumber'),
    rpc<string>('net_peerCount'),
    rpc<false | { currentBlock: string; highestBlock: string }>('eth_syncing'),
  ]);
  return {
    block: block ? Number(block) : null,
    peers: peers ? Number(peers) : null,
    syncing:
      syncing === null
        ? null
        : syncing && typeof syncing === 'object'
          ? { current: Number(syncing.currentBlock), highest: Number(syncing.highestBlock) }
          : false,
    ok: block !== null,
  };
}

export default async function NodePage() {
  const stats = await loadStats();
  const fmt = (n: number | null) => (n === null ? '—' : n.toLocaleString('en-US'));

  return (
    <div className="space-y-8">
      <PageHero
        tone="emerald"
        size="md"
        eyebrow="Infrastructure · Etica 61803"
        title="Run a node. Peer with us."
        description="EticaHub runs a public archive node on Etica Mainnet. Use the endpoints, add our enode to your node, and copy the bootnode list to sync faster."
        actions={
          <>
            <Link href="/network" className="btn-tone px-3.5 py-1.5 text-xs">Wallet setup</Link>
            <Link href="/status" className="btn-ghost px-3.5 py-1.5 text-xs">Status</Link>
          </>
        }
      />

      <section className="surface space-y-4 p-5 md:p-6" aria-labelledby="node-live">
        <h2 id="node-live" className="text-xl font-semibold">Node, live</h2>
        <dl className="grid gap-4 sm:grid-cols-3 text-sm">
          <div>
            <dt className="text-white/60">Status</dt>
            <dd className="text-lg font-semibold">
              {!stats.ok
                ? 'Unreachable'
                : stats.syncing === null
                  ? 'Unknown'
                  : stats.syncing
                    ? 'Syncing'
                    : 'Synced'}
            </dd>
          </div>
          <div>
            <dt className="text-white/60">Block</dt>
            <dd className="font-mono text-lg">
              {fmt(stats.block)}
              {stats.syncing ? <span className="text-white/50"> / {fmt(stats.syncing.highest)}</span> : null}
            </dd>
          </div>
          <div>
            <dt className="text-white/60">Peers</dt>
            <dd className="font-mono text-lg">{fmt(stats.peers)}</dd>
          </div>
        </dl>
        <p className="text-sm text-white/65">
          Archive mode (full historical state), chain ID 61803, refreshed every minute. While syncing, the RPC answers but reports an older head than the network.
        </p>
      </section>

      <section className="surface space-y-4 p-5 md:p-6" aria-labelledby="node-endpoints">
        <h2 id="node-endpoints" className="text-xl font-semibold">Public endpoints</h2>
        <CopyBlock label="JSON-RPC (HTTPS)" value={RPC_HTTP} />
        <CopyBlock label="JSON-RPC (WebSocket)" value={RPC_WS} />
        <CopyBlock label="GraphQL" value={RPC_GRAPHQL} />
        <p className="text-sm text-white/65">
          Methods: eth, net, web3. No API key, no rate limit today; be reasonable. Try queries in the browser at{' '}
          <a className="underline" href={`${RPC_GRAPHQL}/ui`} rel="noreferrer" target="_blank">rpc.eticahub.com/graphql/ui</a>.
        </p>
      </section>

      <section className="surface space-y-4 p-5 md:p-6" aria-labelledby="node-peer">
        <h2 id="node-peer" className="text-xl font-semibold">Peer with us</h2>
        <p className="text-sm text-white/75">
          Running your own Etica node? Add ours and the bootnodes so you find peers immediately. In the geth console (<code>geth attach</code>):
        </p>
        <CopyBlock label="geth console" value={ADD_PEERS_JS} />
        <p className="text-sm text-white/75">
          To make them permanent, save this as <code>static-nodes.json</code> inside your data directory&apos;s <code>geth/</code> folder and restart.
        </p>
        <CopyBlock label="static-nodes.json" value={STATIC_NODES_JSON} />
        <ul className="space-y-1 text-sm text-white/65">
          {PEERS.map((p) => (
            <li key={p.enode} className="break-all">
              <span className="text-white/85">{p.name}</span>: <span className="font-mono text-xs">{p.enode.split('@')[1]}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="surface space-y-3 p-5 md:p-6" aria-labelledby="node-run">
        <h2 id="node-run" className="text-xl font-semibold">Run your own</h2>
        <ol className="list-decimal space-y-2 pl-5 text-sm text-white/75">
          <li>Build <a className="underline" href="https://github.com/etica/core-geth" rel="noreferrer" target="_blank">etica/core-geth</a> (or use the Dockerfile in <a className="underline" href="https://github.com/iamdexx/etica-hub/tree/main/infra/etica-node" rel="noreferrer" target="_blank">etica-hub/infra/etica-node</a>).</li>
          <li>Start with <code>geth --etica --syncmode full</code>; add <code>--gcmode archive</code> if you need historical state.</li>
          <li>Drop the static-nodes.json above into your datadir and open TCP/UDP 30303 so others can peer with you.</li>
        </ol>
        <p className="text-sm text-white/65">Want your node listed here? Send your enode to the Etica Telegram group.</p>
      </section>
    </div>
  );
}
