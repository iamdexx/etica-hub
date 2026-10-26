# Etica archive node (rpc.eticahub.com)

Archive-mode `etica/core-geth` running on the EticaHub droplet next to the
explorer and Hyperlane agents. It exists so TVL/volume aggregators
(DefiLlama, CoinGecko/GeckoTerminal) can query historical state; the public
Etica RPCs are non-archival.

- Droplet path: `/opt/etica-node` (this compose file, `core-geth/` checkout, `data/`)
- Container: `etica-archive`, P2P on 30304 (30303 is taken by the chain validator)
- RPC bound to `127.0.0.1:8547` (HTTP) / `8548` (WS); Caddy serves it as
  `https://rpc.eticahub.com` (see `../droplet/Caddyfile`, container joins `droplet_default`)
- Build: `docker compose build` (Debian/glibc; the upstream Alpine static build fails to link)
- Peers: `data/geth/static-nodes.json`; add live ones with
  `docker exec etica-archive geth attach --exec 'admin.addPeer("enode://...")' /data/geth.ipc`
- Status: `docker exec etica-archive geth attach --exec 'eth.syncing' /data/geth.ipc`
- Memory cap 2.2 GB; if the 4 GB droplet swaps, resize to 8 GB before anything else.
