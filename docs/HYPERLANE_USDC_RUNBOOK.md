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
| Validator (1-of-1 `messageIdMultisigIsm` module on both routers) | EticaHub key, automated                   | Can only attest to what the origin mailbox actually emitted; a compromised validator + relayer could forge a message, so **raise to ≥2-of-3 with an external validator before meaningful TVL** (`hyperlane warp apply` with a new ISM — no redeploy, no fund movement). Until then the two rows below cap the damage. |
| Rate limit (`rateLimitedIsm`, Ethereum router only)       | Owned by `OWNER`                          | Caps USDC *released from the collateral* at 5,000 USDC per rolling 24 h at launch (~0.0579 USDC/s refill). A forged redemption drains at most that per day before the pause lands. Raise with volume via `setRefillRate`. |
| Pause (`pausableIsm` on both routers)                     | Owned by `GUARDIAN`                       | Halts inbound delivery on that chain; cannot move funds or change anything else. Intended for a hot key on the healthcheck host so a `supply != locked` breach pauses within one check interval. |
| Relayer                                                   | EticaHub key, automated                   | Pays gas, cannot alter messages. Whitelisted to the two routers only.                                                                                                                                                                                                   |
| Fee contracts (one per router)                            | Owned by the relayer EOA (`KEEPER`)       | Ethereum: `LinearFee` 50 bps ≤ 50 USDC. Etica: `WarpFlatLinearFee` flat 2 USDC.e + 50 bps ≤ 50. Owner can only `claim` the balance to an address; rate and cap are immutable. The router owner can repoint `feeRecipient` (or clear it) at any time. |
| Router/mailbox owner                                      | `OWNER` = treasury wallet `0xB2B4…C19D` at launch | Can pause the route, swap ISM/hook, raise the cap, transfer ownership (to a Safe later, see Operations). Receives no fees. Never touches user balances.                                                                                                              |
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

1. Each transfer pays `amount × 50 bps` (cap 50 USDC) into the router's fee
   contract; Etica redemptions add a flat 2 USDC.e on top, so a 1 USDC.e
   redemption cannot make the relayer spend ~$3 of Ethereum gas for a
   0.005 fee. On Ethereum the fee is pulled from the sender alongside the
   locked amount; on Etica it is moved from the sender to the fee contract
   before the burn (never minted). `USDC.e supply == USDC locked` still holds.
2. The hourly `Bridge gas keeper` workflow (`apps/keeper`, `bridge-gas:*`),
   signed by the relayer EOA, claims the fee contracts (`claim(keeper)`) and
   — only when ETH / EGAZ is under `MIN_NATIVE` — swaps just enough:
   `USDC → WETH` on Uniswap V2 and unwraps; `USDC.e → ETX → WEGAZ` on
   EticaSwap and unwraps. Swaps use exact-amount approvals, `amountOutMin`
   from a marginal-price probe (`BRIDGE_GAS_MAX_SLIPPAGE_BPS`, 1.5 %, hard
   ceiling 5 %) and are sent through Flashbots Protect on Ethereum so they
   never appear in the public mempool (sandwich exposure on Etica is bounded
   by the same `amountOutMin`; the chain has no public MEV infrastructure).
   A blocked/failed leg fails the job → Telegram via `ops-alerts`.
3. Whatever stable remains above the operating reserve (500 USDC /
   500 USDC.e) becomes keeper EGAZ: on Etica it is swapped
   USDC.e → ETX → WEGAZ → EGAZ on the pinned router, at most
   `BRIDGE_ETICA_MAX_SURPLUS_SWAP` (250 USDC.e) per hourly run and within the
   same price-impact ceiling as the gas swap, and simply stays in the keeper
   wallet — there is no upper EGAZ target, the balance just grows and also
   fuels the farm harvest / forfeit jobs that share the key. On Ethereum
   the USDC surplus is bridged over the route itself to the keeper's own
   Etica address and swapped on the next run. Bridge revenue never reaches
   any other wallet: the swap path and the canonical Ethereum Mailbox are
   compiled into the keeper, and the collateral router named in CI is
   verified on-chain against them before every send.
4. On Etica the keeper also sends 2 EGAZ to wallets that just received
   ≥ 20 USDC.e and hold < 0.5 EGAZ, so a fresh wallet can move its funds.
   Recipients are read from the router's own `ReceivedTransferRemote` events
   (only emitted after the ISM accepted the message), never from user input.

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
- [ ] `OWNER` = treasury wallet `0xB2B4bC9d02970A55efF64C2D84c622c87967C19D` (the
      workflow default). It owns everything and earns nothing; move it to a
      Safe with `transferOwnership` once one exists (recipe under Operations).
      It needs ~0.01 ETH and a few EGAZ for admin calls.
- [ ] Three fresh keys, never reused: deployer (`HYP_KEY`), `VALIDATOR_KEY`, `RELAYER_KEY`.
      Prefer AWS KMS for validator/relayer (`--validator.type aws`, see Hyperlane docs);
      hex keys are acceptable for launch if the host is locked down.
- [ ] Funding: deployer >= 0.05 ETH (core is _not_ deployed on Ethereum — only
      the router + fee contract, ~0.02 ETH at 2 gwei; the workflow pre-flight
      checks the balance against the live gas price) + 5 EGAZ;
      relayer 0.1 ETH + 50 EGAZ as the initial buffer (fees refill it after);
      validator 0.005 ETH + 1 EGAZ (one announcement tx per chain).
- [ ] `KEEPER` = the relayer EOA's address. Same key as `HARVEST_KEEPER_PRIVATE_KEY`
      if you reuse the farm keeper; it becomes the fee contracts' owner.
- [ ] Ethereum RPC: optional. Everything defaults to a keyless public
      rotation (tenderly, mevblocker, drpc, publicnode) with failover; the
      `BRIDGE_ETHEREUM_RPC_URL` secret (comma-separated) on `harvest-live`
      and `ETHEREUM_RPC_URLS` on the agent host only *prepend* your own
      provider. Trust model: the keeper verifies every read against
      on-chain state and the relayer can only deliver what the ISM accepts,
      so a bad endpoint delays those; the validators run their endpoints in
      quorum (`VALIDATOR_RPC_CONSENSUS=quorum`) because a validator signs
      whatever its RPC shows it — keep >= 3 independent operators in the
      list. Cost of going keyless: under throttling, deliveries and keeper
      runs retry later instead of landing in ~2 minutes.
- [ ] VPS (2 vCPU / 2 GB, Docker) with `git clone` of this repo.

Deploy — from the app (preferred)

1. Open https://eticahub.com/deploy/bridge with the keeper wallet
   (`BRIDGE_ROLES.keeper`) in MetaMask on Etica Mainnet.
2. Check the pre-flight (keeper ETH/EGAZ vs live gas, RPC chain ids, roles,
   dispatch token). Owner / validator / guardian default to `BRIDGE_ROLES`
   in `packages/shared/src/addresses.ts`; the validator and guardian keys
   were generated on the agent droplet (`/root/eticahub-keys/*.env`).
3. Sign *pre-flight only* — the wallet signs an EIP-712 `BridgeDeploy`
   message, `/api/bridge/deploy` checks it recovers to the keeper, burns the
   nonce in Redis and dispatches the `Bridge deploy` workflow with
   `confirm=''`, which stops after its own checks.
4. Type `DEPLOY-MAINNET`, sign *deploy*. The workflow runs `deploy.sh` with
   the keeper key from `harvest-live` (it never leaves GitHub) and pushes the
   rendered registry to `bridge-deploy/<run_id>`; the page lists the
   addresses once the run is green. Open a PR from that branch and wire the
   addresses (below).

Deploy — by hand (from repo root, Node ≥ 22)

```bash
export OWNER=0x… VALIDATOR=0x… KEEPER=0x… HYP_KEY=0x…
./infra/hyperlane/deploy.sh core          # Mailbox/ISM/hooks on Etica (~2.5 EGAZ)
./infra/hyperlane/deploy.sh warp          # routers + fee contracts on Ethereum + Etica, enrolls both
./infra/hyperlane/deploy.sh agent-config  # infra/hyperlane/agents/agent-config.json (index.from pinned near head)
unset HYP_KEY
git add infra/hyperlane/registry infra/hyperlane/agents/agent-config.json && git commit
```

`deploy.sh` does not run the stock `@hyperlane-xyz/cli`: Etica's CoreGeth has
no Cancun fork (MCOPY, TSTORE/TLOAD and BASEFEE are invalid opcodes), and the
CLI embeds Cancun bytecode — the first mainnet attempt died at the first
contract creation with `invalid opcode: MCOPY`. `infra/hyperlane/paris-cli.sh`
installs the pinned CLI, rebuilds the matching `@hyperlane-xyz/core` sources
with `evm_version = paris` (`TransientStorage` rewritten to plain storage; the
only user on this route is the token router's reentrancy guard, which clears
its slot in the same call) and swaps every embedded `*_factory_bytecode`
constant. Same sources, same ABIs; only the EVM target changes. Cached under
`~/.cache/eticahub-hyperlane-paris`; delete it to rebuild.

Agents (on the VPS)

```bash
cd infra/hyperlane/agents
cp .env.example .env && $EDITOR .env      # VALIDATOR_KEY from /root/eticahub-keys/validator.env, RELAYER_KEY, RELAYER_WHITELIST from etica-config.yaml
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
- **First message from a chain never delivers** (indexed, no `Processing`
  logs, `hyperlane_last_known_message_nonce{phase="db_loader_loop"}` = 0):
  the relayer's message loader starts at nonce 0 on an empty DB and, because
  `index.from` is pinned near head, nonce 0 is never indexed so it never
  advances (agents-v2.3.0). `docker restart hl-relayer` once: on restart it
  resumes from the highest nonce in its DB. `healthcheck.sh` detects this from
  `/metrics` and performs the restart itself (so the cron must be installed
  before the launch smoke test); expect the very first transfer per origin to
  take up to one cron interval longer.
- **Validator "Please send tokens to your chain signer address to announce"**:
  the validator key needs a little gas on *both* chains for its one-time
  announcement (0.005 ETH / 1 EGAZ). Never announce with a key anyone else
  knows: the Sepolia rehearsal showed Anvil's default key already announced
  by a stranger and swept the moment it was funded.
- **Relayer out of gas**: the gas keeper refills from accrued fees every hour;
  the healthcheck alert below `MIN_RELAYER_ETH/EGAZ` means fees are not covering
  usage (no volume, thin USDC.e/ETX pool, or the keeper job is failing — check
  its Actions log). Top up by hand only then.
- **Invariant alert** (`supply > locked`): the GUARDIAN calls `pause()` on the
  `pausableIsm` of both routers (no Safe round-trip needed), then investigate
  the message log before `unpause()`. After unpause, expect the relayer to
  redeliver queued messages within a few minutes, not seconds — it backs off
  on repeated `Pausable: paused` reverts (audit F-13).
- **Raise the daily cap**: the Ethereum router's `rateLimitedIsm` launches at
  5,000 USDC per rolling 24 h. The OWNER signs one call with the new 24 h
  capacity in USDC base units (6 decimals); it takes effect immediately, no
  redeploy or pause:

  ```sh
  # 25,000 USDC / 24h
  cast send $RATE_LIMITED_ISM 'setRefillRate(uint256)' 25000000000 \
    --rpc-url $ETHEREUM_RPC --private-key $OWNER_KEY   # or via the Safe UI
  ```

  The ISM address is in the rendered registry (`warp-usdc` → ethereum →
  `interchainSecurityModule.modules[rateLimitedIsm]`).
- **Move ownership** (treasury → Safe or any wallet): the current OWNER
  signs one `transferOwnership(newOwner)` per owned contract, after which it
  has no power over the route. Addresses are in the rendered registry
  (`registry/chains/etica/addresses.yaml`, `registry/deployments/warp_routes/USDC/etica-config.yaml`).
  Unrecoverable if `newOwner` is wrong — send a 0-value test tx to it first.

  Only `Ownable` contracts take the call: the static multisig/aggregation
  ISMs have no owner, and both `pausableIsm` modules belong to `GUARDIAN`
  (rotate those separately with `GUARDIAN_KEY`). Don't forget the Etica
  `protocolFee` required hook — it is owned by `OWNER` too.

  ```sh
  # Etica (--legacy): mailbox, core proxyAdmin, protocolFee required hook, synthetic router + its proxyAdmin
  for c in $MAILBOX $CORE_PROXY_ADMIN $PROTOCOL_FEE_HOOK $ETICA_ROUTER $ETICA_PROXY_ADMIN; do
    cast send $c 'transferOwnership(address)' $NEW_OWNER --rpc-url $ETICA_RPC --private-key $OWNER_KEY --legacy
  done
  # Ethereum: collateral router + its proxyAdmin, rateLimitedIsm
  for c in $ETH_ROUTER $ETH_PROXY_ADMIN $RATE_LIMITED_ISM; do
    cast send $c 'transferOwnership(address)' $NEW_OWNER --rpc-url $ETHEREUM_RPC --private-key $OWNER_KEY
  done
  # pause switches belong to the guardian: skipped unless NEW_GUARDIAN is set (separate key, separate decision)
  if [ -n "${NEW_GUARDIAN:-}" ]; then
    cast send $ETICA_PAUSABLE_ISM 'transferOwnership(address)' $NEW_GUARDIAN --rpc-url $ETICA_RPC --private-key $GUARDIAN_KEY --legacy
    cast send $ETH_PAUSABLE_ISM   'transferOwnership(address)' $NEW_GUARDIAN --rpc-url $ETHEREUM_RPC --private-key $GUARDIAN_KEY
  fi
  for c in $MAILBOX $CORE_PROXY_ADMIN $PROTOCOL_FEE_HOOK $ETICA_ROUTER $ETICA_PROXY_ADMIN; do cast call $c 'owner()(address)' --rpc-url $ETICA_RPC; done   # verify each
  ```
- **Security audit**: findings, fork evidence and the mainnet blocker list live
  in `docs/BRIDGE_SECURITY_AUDIT.md`.
- **Rotate / add validators**: run the new validator (announced on both
  chains), then deploy the new ISM with the core factories and point the
  router at it as OWNER. `hyperlane warp apply` does **not** work on this
  route: it reads the Etica fee contract as a CLI `LinearFee` (`maxFee()`),
  which `WarpFlatLinearFee` does not expose, and aborts before writing. The
  factory path is three calls per chain (addresses in
  `registry/chains/<chain>/addresses.yaml`):

  ```sh
  MS=$(cast call $staticMessageIdMultisigIsmFactory 'deploy(address[],uint8)(address)' "[$V1,$V2]" 2 --rpc-url $RPC)
  cast send $staticMessageIdMultisigIsmFactory 'deploy(address[],uint8)' "[$V1,$V2]" 2 --rpc-url $RPC --private-key $OWNER_KEY
  AGG=$(cast call $staticAggregationIsmFactory 'deploy(address[],uint8)(address)' "[$MS,$RATE_LIMITED_ISM,$PAUSABLE_ISM]" 3 --rpc-url $RPC)
  cast send $staticAggregationIsmFactory 'deploy(address[],uint8)' "[$MS,$RATE_LIMITED_ISM,$PAUSABLE_ISM]" 3 --rpc-url $RPC --private-key $OWNER_KEY
  cast send $ROUTER 'setInterchainSecurityModule(address)' $AGG --rpc-url $RPC --private-key $OWNER_KEY
  ```

  (Etica router: multisig + pausable, threshold 2. Ethereum router: multisig +
  rateLimited + pausable, threshold 3.) Never change the ISM to a set whose
  signatures you cannot produce.
- **Upgrade agents**: bump `HYPERLANE_AGENT_TAG`, `docker compose pull && up -d`. Never below `agents-v2.3.0`: older relayers cannot deliver through the
  RateLimitedIsm aggregation and every redemption stalls with `Aggregation threshold not met`.
  DBs under `data/` are safe across upgrades.

## Testnet rehearsal (Ethereum Sepolia ↔ Etica anvil fork)

Run before any mainnet gas was spent, with this repo's compose/agent flags
(agents-v2.3.0, validator `quorum` over three keyless Sepolia RPCs, relayer
`fallback`, 100-block log chunks) against Hyperlane's canonical Sepolia core
and our Etica core on a fork at `127.0.0.1:8547`. Throwaway keys only.

| Step | Evidence |
| --- | --- |
| Warp deploy, Sepolia collateral `0xBe28…4490` ↔ Etica synthetic `0x4A21…8bA3`, fee contracts on both | `quoteTransferRemote(10 USDC)` = 10.05 USDC (50 bps) |
| Sepolia → Etica, 10 USDC | lock [`0x373b…f2f6`](https://sepolia.etherscan.io/tx/0x373b4d0cbafdeec735839fa1e40a28b18d273e89a02b9b3bda6487409fbfd2f6) → mint on Etica `0x0e3c…e509`: 10 USDC.e to a wallet holding 0 EGAZ; 0.05 USDC in the Sepolia fee contract |
| Gas drop | `bridge-gas` keeper scanned the inbound mint and sent 2 EGAZ; second run skipped the same recipient |
| Etica → Sepolia, 3 USDC.e | burn on Etica `0xa370…63bf` → release on Sepolia; Etica fee contract 2.015 USDC.e (flat 2 + 0.5 %); supply 7.000000 == locked 7.000000 |
| Fee sweep | keeper `claim` on Etica 2.015 USDC.e → keeper wallet; owner `claim` on Sepolia 0.05 USDC [`0xe111…08b0`](https://sepolia.etherscan.io/tx/0xe11146d28252455d56c84260ffad3aa126804d030a26e95e7d0635b85c0d08b0) |
| Public-RPC behaviour | PublicNode/Tenderly returned `-32005 rate limit exceeded` throughout; agents deprioritised and retried, nothing dropped |

Two defects found and fixed here, both of which would have stalled the first
mainnet transfer: the CLI's `index.from` (mailbox deploy block) made the
agents backfill history over throttled public RPCs (`deploy.sh agent-config`
now pins it near head), and the relayer's first-message stall described under
Operations (now auto-restarted by `healthcheck.sh`). Not exercised on
Sepolia: the Ethereum keeper leg (chain id 1 only; proven on the mainnet
fork in `docs/BRIDGE_SECURITY_AUDIT.md`).

Neither rehearsal caught the Cancun problem because anvil runs the latest
EVM by default. Fork Etica with `anvil --fork-url … --hardfork shanghai`
(PUSH0 yes, MCOPY no — the same opcode set as Etica mainnet) for any further
local run: the stock CLI reproduces the mainnet failure there (`EVM error
NotActivated`), and the Paris CLI from `paris-cli.sh` deployed core + warp
route and passed 100 USDC → 100 USDC.e, 30 USDC.e → 30 USDC, fee contracts
0.5 USDC / 2.15 USDC.e and the keeper claim on that fork.

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
