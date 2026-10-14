# EticaSwap Direct — internal security audit

Scope: `packages/contracts/src/direct/` (`EticaDirectFactory`, `EticaDirectPair`, `EticaDirectERC20`, `EticaDirectLibrary`, `EticaDirectRouter`, `DirectSwapHarvesterAdapter`, `IEticaDirectFactory`) at PR #346. Method: line-by-line review against the audited EticaSwap V2 sources they were derived from (diffs are limited to the gate, the 1.00% fee constants, LP name/symbol and the curated `createPair`), Slither 0.10 (`--exclude-informational --exclude-optimization --exclude-low`), and adversarial Foundry tests in `test/direct/EticaDirect.t.sol` (14 tests).

Nothing is deployed; all fixes below are in the PR.

## Findings

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| 1 | High | Gate bypass via sibling pair: `isAllowed` trusted every venue pair, so a non-staker could call `pair.swap(..., to = otherPair)` and `skim` the output out. | Fixed: pairs are no longer "allowed" accounts; a pair/whitelisted `to` is accepted only when `msg.sender` is whitelisted (the router/harvester doing a hop). `skim(to)` is gated. Test `test_swap_nonStakerCannotParkOutputOnSiblingPair`. |
| 2 | Medium | Non-staker could dump swap output into the whitelisted router/harvester (`to = router`). Funds would be stranded (the router never sweeps its own balance), so no theft, but it let outsiders trade the pair's price and grief. | Fixed by the same rule as #1; router `gated(to)` additionally rejects `to == router` and `to == any pair` (`EDirect: INVALID_TO`). Test `test_gate_venueContractsAreNotRecipientsForOutsiders`. |
| 3 | Medium | `EticaDirectRouter._addLiquidity` called `pairCreationFee()` / `etx()` on a factory without them, so liquidity could never be added to an unopened pair (revert instead of create). | Fixed: pairs are curated, the router requires the pair to exist (`EDirect: NO_PAIR`). Test `test_addLiquidity_unopenedPairReverts`. |
| 4 | Low | Fee LP of a direct pair whose token has no ETX hub pool cannot be harvested until that hub pool exists (adapter sells every leg through the hub). No loss: LP waits in the adapter. | Accepted; curation rule documented in `docs/ETICASWAP_DIRECT.md`. |
| 5 | Low | Harvest MEV: the keeper supplies `minEtxOut*` / `minPolOut*`; a zero plan would let a sandwicher take the harvest. | Accepted by design (keeper-only, mirrors `TreasuryHarvester`); the keeper quotes a block earlier and never submits zero min-outs. Enforced operationally, not on-chain. |
| 6 | Low | POL buyback deposits the two legs half/half by ETX value; the pair's ratio decides how much LP mints and the remainder is left in the pair as reserves (donated to all LPs, incl. the dead-address POL). | Accepted; documented in the adapter. |
| 7 | Info | Gate is a balance check at execution time. A wallet can buy stETX, trade, and sell stETX in one transaction. This is intended: the gate is "stake ETX to use direct routes", and the round-trip costs stableswap fees. There is no flash-loan source for stETX. | Accepted. |
| 8 | Info | Admin surface: `feeToSetter` (treasury) can change `minStEtx` (incl. to brick the venue), whitelist, trusted creators and `feeTo`; adapter owner can `rescue` tokens sitting in the adapter (incl. unharvested fee LP) and change sinks/split. Single-key trust identical to the rest of the protocol. | Accepted; move `feeToSetter`/owner to the multisig when one exists. |
| 9 | Info | LP tokens are freely transferable; a non-staker can hold direct LP but cannot `burn` it (gated). | Accepted. |

## Slither triage

All remaining medium findings are the inherited Uniswap V2 patterns and are protected the same way as in V2 / EticaSwap:

- `reentrancy-no-eth` in `mint`/`burn`/`swap`/`skim`/`createPair`: every pair entry point runs under the `lock` mutex; `createPair` only calls the pair it just deployed.
- `unchecked-transfer` in `removeLiquidity` (`pair.transferFrom`): `EticaDirectERC20.transferFrom` reverts on insufficient balance/allowance, it never returns false.
- `weak-prng` on `block.timestamp % 2**32`: TWAP timestamp wrap, not randomness.
- `divide-before-multiply` in `harvest`: intentional, computes the per-pair rounding dust sent to treasury.
- `incorrect-equality` on `== 0` guards: zero-amount short-circuits.

## Invariants covered by tests

- Only `feeToSetter`/trusted creators open pairs; no ETX rule, no creation fee.
- `isAllowed`: whitelist, `minStEtx == 0`, stETX balance; pairs are never allowed accounts.
- Add/remove liquidity and swaps through the router and directly on the pair require a staker recipient; transferring stETX away revokes access; router/pair/adapter cannot be used as recipients by outsiders.
- Swap fee is 1.00% (`990/1000`): a 0.30%-sized output fails the K check; router quotes match the pair.
- V2 `Sync`/`Swap`/`PairCreated` events for indexers.
- Harvest: 10% stETX (NAV rises), 10% farms, 40% POL LP burned to `0xdead`, 40% + dust to treasury; adapter ends with zero ETX and zero LP; keeper-only; venue pairs only.
