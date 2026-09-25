# USDC.e on Etica — Hyperlane warp route runbook

USDC.e is Circle USDC bridged from Ethereum to Etica through a
[Hyperlane warp route](https://docs.hyperlane.xyz/docs/guides/warp-routes/deploy-a-warp-route):
real USDC is locked in an audited `HypERC20Collateral` router on Ethereum and
exactly that many USDC.e (`HypERC20`) are minted on Etica. Burning USDC.e
releases USDC. No yield, no rebase, no admin mint; `USDC.e.totalSupply()
== USDC.balanceOf(collateralRouter)` by construction.

Everything under `infra/hyperlane/` has been exercised end-to-end against anvil
forks of both chains (core deploy, warp deploy, 250 USDC → USDC.e mint, 100
USDC.e → USDC redemption, driven by the exact docker-compose agents below).
**Nothing is deployed to mainnet yet.**

## Layout

```
infra/hyperlane/
  registry/chains/etica/metadata.yaml     Etica chain metadata (domain 61803)
  configs/core-config.yaml                Mailbox + default ISM/hooks for Etica
  configs/warp-usdc.yaml                  USDC (collateral) <-> USDC.e (synthetic)
  deploy.sh                               renders placeholders, runs the CLI
  agents/docker-compose.yml               2 validators + 1 relayer
  agents/.env.example                     keys, RPCs, whitelist, Telegram
  agents/healthcheck.sh                   cron probe + supply invariant
```

`registry/` is a local Hyperlane registry: after mainnet deploy it will also
contain `chains/etica/addresses.yaml` and
`deployments/warp_routes/USDC/etica-config.yaml`. Commit both (addresses only,
no secrets) and upstream them to
[hyperlane-registry](https://github.com/hyperlane-xyz/hyperlane-registry) so
the public Hyperlane explorer and warp UI pick the route up.

## Trust model and controls

| Component                                                 | Who                                       | Bound by                                                                                                                                                                                                                                                                |
| --------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Validator (1-of-1 `messageIdMultisigIsm` on both routers) | EticaHub key, automated                   | Can only attest to what the origin mailbox actually emitted; a compromised validator + relayer could forge a message, so **raise to ≥2-of-3 with an external validator before meaningful TVL** (`hyperlane warp apply` with a new ISM — no redeploy, no fund movement). |
| Relayer                                                   | EticaHub key, automated                   | Pays gas, cannot alter messages. Whitelisted to the two routers only.                                                                                                                                                                                                   |
| Router/mailbox owner                                      | `OWNER` (a Safe + timelock before launch) | Can pause the route, swap ISM/hook, transfer ownership. Never touches user balances.                                                                                                                                                                                    |
| Reserve                                                   | `HypERC20Collateral` contract on Ethereum | Only released by a verified message from the Etica router.                                                                                                                                                                                                              |

Normal operation needs no human signature — this is the "fully autonomous"
requirement. Admin actions (pause, ISM upgrade) are rare and go through the
owner Safe.

"0 fail" is a target, not a guarantee: failure modes are bounded to _delay_
(agent down → messages queue until it is back; nothing is lost because
Hyperlane messages are replayable) and _stall_ (pause). Money can only be lost
if the validator key is compromised _and_ used to forge a message — hence the
multi-validator upgrade above and hardware/KMS custody of `VALIDATOR_KEY`.

## Mainnet deploy — checklist

Pre-reqs

- [ ] Legal review of the operator/issuer position (see below) signed off.
- [ ] Owner Safe created (Ethereum + Etica). `OWNER` = Safe address.
- [ ] Three fresh keys, never reused: deployer (`HYP_KEY`), `VALIDATOR_KEY`, `RELAYER_KEY`.
      Prefer AWS KMS for validator/relayer (`--validator.type aws`, see Hyperlane docs);
      hex keys are acceptable for launch if the host is locked down.
- [ ] Funding: deployer ~0.15 ETH (core is _not_ deployed on Ethereum — only
      the router, ~0.01–0.03 ETH depending on gas) + 5 EGAZ; relayer 0.1 ETH + 50 EGAZ;
      validator 0.005 ETH + 1 EGAZ (one announcement tx per chain).
- [ ] Paid RPC endpoints for Ethereum (Alchemy/Infura). Public endpoints
      rate-limit `eth_getLogs` and the agents will fall behind.
- [ ] VPS (2 vCPU / 2 GB, Docker) with `git clone` of this repo.

Deploy (from repo root, Node ≥ 22)

```bash
export OWNER=0x… VALIDATOR=0x… HYP_KEY=0x…
./infra/hyperlane/deploy.sh core          # Mailbox/ISM/hooks on Etica (~2.5 EGAZ)
./infra/hyperlane/deploy.sh warp          # routers on Ethereum + Etica, enrolls both
./infra/hyperlane/deploy.sh agent-config  # infra/hyperlane/agents/agent-config.json
unset HYP_KEY
git add infra/hyperlane/registry infra/hyperlane/agents/agent-config.json && git commit
```

Agents (on the VPS)

```bash
cd infra/hyperlane/agents
cp .env.example .env && $EDITOR .env      # keys, RPCs, RELAYER_WHITELIST from etica-config.yaml
docker compose up -d
docker compose logs -f                    # validators: "announced signature storage location"
./healthcheck.sh                          # then add to cron: */5 * * * *
```

Smoke test with your own funds before announcing

```bash
hyperlane warp send --warp-route-id USDC/etica --origin ethereum --destination etica \
  --amount 1000000 --registry ./infra/hyperlane/registry -k $TEST_KEY   # 1 USDC
hyperlane warp send --warp-route-id USDC/etica --origin etica --destination ethereum \
  --amount 1000000 --registry ./infra/hyperlane/registry -k $TEST_KEY
```

Wire into the app

- `USDC_WARP_ROUTE.collateralRouter` / `.syntheticToken` in `packages/shared/src/addresses.ts`.
- EticaSwap USDC.e/ETX pool; list USDC.e in the token registry (6 decimals).
- Mint/redeem UI behind the existing geo-gate until counsel clears US access.

## Operations

- **Agent down**: `docker compose ps`; `restart: unless-stopped` covers crashes.
  Messages sent while the relayer is down are delivered when it returns.
- **Relayer out of gas**: healthcheck alerts below `MIN_RELAYER_ETH/EGAZ`; top up.
- **Invariant alert** (`supply > locked`): pause both routers from the Safe
  (`hyperlane warp apply` with `paused` ISM, or `pause()` on the router if the
  deployed version exposes it), then investigate the message log before resuming.
- **Rotate validator**: run a second validator with the new key, deploy a
  2-of-2 ISM via `hyperlane warp apply`, retire the old one. Never change the
  ISM to a set whose signatures you cannot produce.
- **Upgrade agents**: bump `HYPERLANE_AGENT_TAG`, `docker compose pull && up -d`.
  DBs under `data/` are safe across upgrades.

## Legal position (engineering summary — not advice)

Designed to stay on the lower-risk side of the lines discussed:

- Not issued by EticaHub: the asset holders own is Circle USDC held by a
  contract; USDC.e is a receipt for it. No yield, interest, revenue share,
  governance rights or appreciation — nothing resembling an investment contract.
- EticaHub operates messaging infrastructure (validator/relayer) and owns the
  pause switch. That is closer to a bridge operator than an issuer, but bridge
  operation can still be money transmission / custody / VASP activity in many
  jurisdictions, and GENIUS-style stablecoin rules may reach it.
- Open items for counsel before launch: operating entity and jurisdiction,
  whether mint/redeem must be geo-gated (US) and KYC'd, sanctions screening on
  the relayer whitelist, terms of use, disclosures ("USDC.e is not USDC and is
  not issued by Circle"), reserve transparency page (the invariant above,
  published live).

Do not describe USDC.e as "regulated", "insured", or "backed by EticaHub".
Say: "USDC bridged to Etica via Hyperlane; 1:1 with USDC locked on Ethereum".
