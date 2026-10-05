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
| Fee contracts (`LinearFee`, one per router)               | Owned by the relayer EOA (`KEEPER`)       | Receive 10 bps (≤ 5 USDC) of every transfer in the bridged asset. Owner can only `claim` the balance to an address; rate and cap are immutable. The router owner can repoint `feeRecipient` (or clear it) at any time.                                                   |
| Router/mailbox owner                                      | `OWNER` (a Safe + timelock before launch) | Can pause the route, swap ISM/hook, transfer ownership. Never touches user balances.                                                                                                                                                                                    |
| Reserve                                                   | `HypERC20Collateral` contract on Ethereum | Only released by a verified message from the Etica router.                                                                                                                                                                                                              |

Normal operation needs no human signature — this is the "fully autonomous"
requirement. Admin actions (pause, ISM upgrade) are rare and go through the
owner Safe.

Public wording: **automated, single-validator at launch, upgradeable to an
independent multi-validator set**. Not "trustless" — with one validator, users
trust the operator exactly as with any lock-and-mint bridge.

### Gas: paid by users, converted by the relayer

Gas is ETH on Ethereum and EGAZ on Etica; the fee is collected in USDC /
USDC.e. The relayer closes that gap itself, with no treasury key anywhere:

1. Each transfer pays `amount × 10 bps` (cap 5 USDC) into the router's fee
   contract. On Ethereum the fee is pulled from the sender alongside the
   locked amount; on Etica it is moved from the sender to the fee contract
   before the burn (never minted). `USDC.e supply == USDC locked` still holds.
2. The hourly `Bridge gas keeper` workflow (`apps/keeper`, `bridge-gas:*`),
   signed by the relayer EOA, sweeps the fee contracts (`claim(keeper)`) and
   — only when ETH / EGAZ is under `MIN_NATIVE` — swaps just enough:
   `USDC → WETH` on Uniswap V2 and unwraps; `USDC.e → ETX → WEGAZ` on
   EticaSwap and unwraps. Swaps are capped by a price-impact guard
   (`BRIDGE_GAS_MAX_SLIPPAGE_BPS`, 3 %) and a blocked/failed leg fails the
   job → Telegram via `ops-alerts`.

Limits, stated plainly: this funds gas from _volume_. Zero transfers means
zero fees, so launch with the relayer buffer below and keep the low-balance
alert; the Etica leg needs a USDC.e/ETX pool with real depth or the guard
will refuse to swap. Hyperlane's IGP is deliberately not used: it would
charge ETH for Etica delivery and EGAZ for Ethereum delivery, i.e. the wrong
asset on each side, and needs a price oracle kept current by someone.

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
      the router + fee contract, ~0.02–0.05 ETH depending on gas) + 5 EGAZ;
      relayer 0.1 ETH + 50 EGAZ as the initial buffer (fees refill it after);
      validator 0.005 ETH + 1 EGAZ (one announcement tx per chain).
- [ ] `KEEPER` = the relayer EOA's address. Same key as `HARVEST_KEEPER_PRIVATE_KEY`
      if you reuse the farm keeper; it becomes the fee contracts' owner.
- [ ] `BRIDGE_ETHEREUM_RPC_URL` secret on the `harvest-live` GitHub environment
      (the gas keeper's Ethereum provider).
- [ ] Paid RPC endpoints for Ethereum (Alchemy/Infura). Public endpoints
      rate-limit `eth_getLogs` and the agents will fall behind.
- [ ] VPS (2 vCPU / 2 GB, Docker) with `git clone` of this repo.

Deploy (from repo root, Node ≥ 22)

```bash
export OWNER=0x… VALIDATOR=0x… KEEPER=0x… HYP_KEY=0x…
./infra/hyperlane/deploy.sh core          # Mailbox/ISM/hooks on Etica (~2.5 EGAZ)
./infra/hyperlane/deploy.sh warp          # routers + fee contracts on Ethereum + Etica, enrolls both
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
  The pool is also the gas keeper's EGAZ source — seed it with enough depth
  that a few-hundred-EGAZ swap stays under 3 % impact. EticaSwap's factory
  charges `pairCreationFee` (10,000 ETX at time of writing, paid to the
  treasury) on top of the deposit unless the creator is a `trustedCreator`.
- GitHub `harvest-live` variables for the gas keeper: `BRIDGE_ETHEREUM_FEE_CONTRACT`,
  `BRIDGE_ETICA_FEE_CONTRACT` (each router's `feeRecipient()`), `BRIDGE_USDCE_ADDRESS`.
  Then dispatch `Bridge gas keeper` with `dry_run=true` and check both legs read
  `idle`/`planned`, not `unconfigured`.
- Mint/redeem UI behind the existing geo-gate until counsel clears US access.

## Operations

- **Agent down**: `docker compose ps`; `restart: unless-stopped` covers crashes.
  Messages sent while the relayer is down are delivered when it returns.
- **Relayer out of gas**: the gas keeper refills from accrued fees every hour;
  the healthcheck alert below `MIN_RELAYER_ETH/EGAZ` means fees are not covering
  usage (no volume, thin USDC.e/ETX pool, or the keeper job is failing — check
  its Actions log). Top up by hand only then.
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
