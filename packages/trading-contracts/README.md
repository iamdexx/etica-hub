# trading-contracts

Non-custodial trading stack for EticaHub. Built on [UniswapX](https://github.com/Uniswap/UniswapX) and [Permit2](https://github.com/Uniswap/permit2), both audited by OpenZeppelin, ABDK, and Trail of Bits.

## What this package contains

- `lib/uniswapx/` — git submodule pinned to unmodified Uniswap Labs [UniswapX](https://github.com/Uniswap/UniswapX). Provides `DutchOrderReactor`, `OrderQuoter`, Permit2 helpers. Deployed bytecode is byte-identical to the audited artifact.
- `src/EticaProtocolFeeController.sol` — our only original contract in this package. Implements `IProtocolFeeController` from UniswapX. Charges a BPS-denominated fee **denominated in ETX** on every reactor fill and routes it to the EticaHub treasury. Hard-capped at 1% (100 BPS).
- `script/DeployTradingStack.s.sol` — deploys `DutchOrderReactor`, `OrderQuoter`, and `EticaProtocolFeeController`, then wires the fee controller onto the reactor. Defaults fee BPS to 0 (fee-off at launch).
- `script/deploy-trading-stack.sh` — bash wrapper that ensures submodules are initialized and shells out to `forge script`.
- `test/EticaProtocolFeeController.t.sol` — unit + fuzz tests for the fee controller.

## Why this is a separate Foundry project

UniswapX pins `solc = 0.8.29` with `optimizer_runs = 1_000_000`. The main DEX package (`packages/contracts`) pins `solc = 0.8.26` with `via_ir = false` and different optimizer settings. Mixing the two in one build is either impossible (solc mismatch) or would break audit-equivalence of the deployed Reactor bytecode.

Keeping this package isolated with its own `foundry.toml` preserves:

1. **Audit inheritance.** The Reactor and Quoter deploy with byte-identical code to upstream UniswapX, which inherits OpenZeppelin + ABDK + Trail of Bits audits.
2. **Build stability.** Changes here don't affect `forge test` for the V2 DEX / launchpad / ETX token suites.

## Fee model

Every EticaSwap pool is ETX-paired (factory enforces hub-and-spoke), so **every trade has exactly one ETX leg**. The fee controller skims a BPS-denominated amount from whichever leg is ETX and emits it as an extra UniswapX output to the treasury. The keeper is responsible for delivering it atomically with the fill — no extra swap hop, no new token flow to audit.

At deploy, `feeBps = 0` (fee-off). The reactor owner can call `EticaProtocolFeeController.setFeeBps(_feeBps)` to turn the fee on any time — same pattern as turning on the V2 pool-creation fee via `factory.setFeeTo`. Hard cap 100 BPS (1%) enforced in the controller constructor and setter.

## Deployment

Prereqs:

- Permit2 deployed on Etica. See [`packages/contracts/script/deploy-permit2.sh`](../contracts/script/deploy-permit2.sh).

```
export ETICA_MAINNET_RPC_URL=https://...
export DEPLOYER_PK=0x...
export PERMIT2_ADDRESS=0x...          # output of deploy-permit2.sh
export ETX_ADDRESS=0xa5a1bc6307b0b87989b8456d4b35f88a68650044
export TREASURY_ADDRESS=0xB2B4bC9d02970A55efF64C2D84c622c87967C19D
export REACTOR_OWNER=0xB2B4bC9d02970A55efF64C2D84c622c87967C19D
# optional:
# export INITIAL_FEE_BPS=0

./packages/trading-contracts/script/deploy-trading-stack.sh
```

Record resulting addresses in `docs/TRADING.md` Appendix B.
