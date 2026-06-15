# wRES — wrap a RES NFT into a TRON energy-miner that pays ETX

This folder holds the **Etica side** of the wRES product. The **TRON side**
(`WrappedRESMiner`, `TrxReserve`) lives in the `UEM` repo under
`contracts/src/`. Together they let an Etica user lock their RES NFT, receive a
TRON energy-miner twin, and earn ETX paid to their Etica wallet.

## The two on-chain halves

| Side | Contract | Role |
| --- | --- | --- |
| Etica (this repo) | `RESLockVault` | Escrows the RES NFT (lock, never burn). Emits `Locked` for the keeper to mint against. Drain-proof: an escrowed NFT can only ever return to its locker. |
| Etica (this repo) | `ETRX` | 1:1-backed bridged TRX. Minted only against TRX locked on TRON; swapped for ETX on the EticaHub DEX. |
| TRON (`UEM` repo) | `WrappedRESMiner` | ERC-721 twin. TRX-upgradable (frozen forever), per-twin MasterChef accumulator for energy revenue, 10% in-kind resource dividend (80% energy / 20% bandwidth). `fundedUpgrade` lets the reserve front TRX. |
| TRON (`UEM` repo) | `TrxReserve` | Fully-reserved TRX float. `frontUpgrade` freezes reserve TRX into a twin; release ≤ balance (can't run dry); per-epoch drip cap; 1% revenue top-up. |

## Keeper / courier loop (off-chain)

The keeper is the only cross-chain actor. It holds no user principal — every
contract is drain-proof independent of keeper honesty (a compromised keeper can
at worst return RES NFTs to their lockers and front already-reserved TRX into
legitimate twins). The loop:

**Entry (Etica → TRON):**
1. Watch `RESLockVault.Locked(resTokenId, owner, tronRecipient, payoutWallet)`.
2. Call `WrappedRESMiner.mintTwin(tronRecipient, payoutWallet, resTokenId)` on TRON.
3. Call `TrxReserve.frontUpgrade(tokenId, amount)` — protocol-fronts the initial
   TRX freeze from the reserve (bounded by float + per-epoch drip cap, so
   onboarding is paced to reserve growth).

**Revenue → payout (TRON → Etica):**
4. Energy/bandwidth sells via any channel (own provider, managed supplier,
   Brutus resale). Keeper routes the twin pool's share to
   `WrappedRESMiner.receiveRevenue()` — the accumulator distributes pro-rata by
   frozen weight. (Resource-dividend 10% leg is delegated in-kind on TRON via
   CoreReactor using `holderResourceDividend` as the per-twin weighting.)
5. Keeper calls `WrappedRESMiner.claimForPayout(tokenId)` to pull settled TRX.
6. Split: **1%** → `TrxReserve.topUp()` (refill the float), **99%** → payout.
7. Lock the 99% TRX on the TRON reserve → mint `ETRX` 1:1 on Etica → swap
   `eTRX → ETX` on the EticaHub DEX → transfer ETX to `payoutWallet`.

**Exit (burn-twin → unlock):**
8. User burns their TRON twin. Keeper confirms and calls
   `RESLockVault.keeperUnlock(resTokenId)` → RES returns to its locker.
9. Liveness fallback: if the keeper is unresponsive, the locker calls
   `requestUnlock` → after `challengeWindow` → `executeUnlock` (permissionless).
   `vetoAuthority` can cancel a pending request while the twin is still live.

## Invariants

- **Lock, never burn** — burning a RES freezes its royalty splitter forever.
- **1:1 backing** — `ETRX.totalSupply() == TRX locked on TRON`.
- **Fully-reserved** — `TrxReserve` releases ≤ its balance; cannot run dry.
- **Onboarding ∝ reserve growth** — the 1% top-up + per-epoch cap throttle entry.
- **No theft surface** — no admin sweep on either side; escrowed RES only ever
  returns to its locker; fronted/upgraded TRX is nonrefundable by design.

## Status / testing

All four contracts have full unit suites (UEM: 37 passing; etica-hub: 20
passing). The **keeper loop above is off-chain and has NOT been
live-integration-tested** — it requires both chains live with bridge
credentials wired. **A testnet dry-run is required before mainnet.**
