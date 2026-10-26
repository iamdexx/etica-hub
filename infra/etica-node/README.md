# Etica archive node (rpc.eticahub.com)

Archive-mode `etica/core-geth` running on the EticaHub droplet next to the
explorer and Hyperlane agents. It exists so TVL/volume aggregators
(DefiLlama, CoinGecko/GeckoTerminal) can query historical state; the public
Etica RPCs are non-archival.

- Droplet path: `/opt/etica-node` (this compose file, `core-geth/` checkout, `data/`)
- Container: `etica-archive`, P2P on 30304 (30303 is taken by the chain validator)
- RPC bound to `127.0.0.1:8547` (HTTP) / `8548` (WS); Caddy serves it as
  `https://rpc.eticahub.com` (see `../droplet/Caddyfile`, container joins `droplet_default`)
- Build: `git clone https://github.com/etica/core-geth && docker compose build` (Debian/glibc; the upstream Alpine static build fails to link)
- Peers: `data/geth/static-nodes.json`; add live ones with
  `docker exec etica-archive geth attach --exec 'admin.addPeer("enode://...")' /data/geth.ipc`
- Status: `docker exec etica-archive geth attach --exec 'eth.syncing' /data/geth.ipc`
- Endpoints: `https://rpc.eticahub.com` (JSON-RPC), `wss://rpc.eticahub.com` (WS), `https://rpc.eticahub.com/graphql`
- RPC exposes `eth,net,web3` only (no `debug`/`txpool`); use the IPC console for those
- Memory cap 2.2 GB; if the 4 GB droplet swaps, resize to 8 GB before anything else.

## Static peers

core-geth ignores `static-nodes.json`; peers are pinned in `/opt/etica-node/data/config.toml`:

```toml
[Node.P2P]
StaticNodes = ["enode://...@host:port", ...]
```

Edit that file and `docker compose up -d` to apply. `admin.addPeer` only lasts until restart.

## Mining pool work

The node runs with `--mine --miner.threads=0 --miner.etherbase 0x679FeeB936ec769c05842bE51b45e3B5b34F43a9`:
threads=0 disables CPU mining but serves `eth_getWork` to the pool in `../etica-pool`. Blocks the pool finds pay out to that address (the pool payout wallet, key in `/root/.etica-pool.env` on the droplet).
