# ETI (RandomX) pool: etipool.eticahub.com

Upstream software: https://github.com/etica/eticapool (0xBitcoin tokenpool fork, Node + Mongo + Redis).
Droplet checkout: `/opt/eti-pool/eticapool`. Stratum ports 3333 / 5555 / 7777 / 9999 (low to very high CPU), PPLNS, fee 0.5%.

- `gen-config.py` renders `pool.config.json` from `pool.config.template.json` + `/root/.eti-pool.env`
  (minting and payments keys, root-only, never committed). The file must be `chown 999` (container user `pool`), mode 600.
- `docker-compose.override.yml` keeps the web UI (8080) and Socket.IO (2053) on localhost, joins
  `droplet_default` so Caddy can proxy `etipool.eticahub.com`, and disables the Mongo backup job.
- Dockerfile is patched from bullseye to bookworm in all three stages (bullseye-security apt packages 404 now).
- BatchedPayments contract: `0x2ab929Ab41b4ba22D66DDeAB075F615888fd050a`, owner = payments wallet
  `0x88d4043aB15443a038df2402a317a3ad20136928`. Minting wallet `0xc5bcf0E8e421fc54d1fDaB035D4A2A653A89ca16`.
- Flow: pool mints ETI to the minting wallet, sweeps it into BatchedPayments (every 80 s), pays miners (100% - fee)
  via `multisend` whenever someone is over 1.5 ETI unpaid (checked every 5 s). The fee share stays in
  BatchedPayments, so `fee-sweep.sh` (root cron, Sundays 03:00 UTC, log `/var/log/eti-fee-sweep.log`) sends
  90% of what the contract holds above miners' unpaid balances to the treasury `0xB2B4bC9d02970A55efF64C2D84c622c87967C19D`
  via the owner-only `send()`; `--dry-run` prints the numbers.
- `paymentsConfig.maxGasPriceGwei` is raised to 50: Etica transactions run at 9-10 gwei and the template's 5 would
  never get a payout mined.
- `web3Provider` is the public eticascan RPC until the archive node is synced, then switch to `http://etica-archive:8545`.
