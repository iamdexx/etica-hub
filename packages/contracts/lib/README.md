# `packages/contracts/lib/` — third-party submodules

| Submodule | Purpose | Compiled in main build? |
|---|---|---|
| `forge-std` | Foundry test utilities | yes (via test imports) |
| `openzeppelin-contracts` | OZ v5 ERC20, Ownable, etc. | yes (imported from `src/`) |
| `v2-core`, `v2-periphery` | Uniswap V2 core + router (reference) | no (EticaSwap already forked + deployed) |
| `permit2` | Uniswap Labs' Permit2 (audited) | **no** — built via its own foundry.toml |

## Why `permit2` is built separately

Permit2 pins `solc = 0.8.17` with `via_ir = true`. Our contracts use `0.8.26` with `via_ir = false`. Mixing the two in a single `forge build` runs into `via_ir` incompatibilities. So we treat `lib/permit2` as a separate Foundry project, invoked only by `script/deploy-permit2.sh` when we actually need to deploy it. This keeps our main build fast and unmodified.

Because Permit2 is built under its own `foundry.toml` with identical flags to the upstream audited contract, the deployed bytecode is **identical to the audited Permit2** at `0x000000000022D473030F116dDEE9F6B43aC78BA3` on mainnet Ethereum and every other chain it's canonically deployed to.

We do **not** currently deploy at the canonical address on Etica. Doing so would require first deploying the [Arachnid CREATE2 deployer proxy](https://github.com/Arachnid/deterministic-deployment-proxy) at `0x4e59b44847b379578588920cA78FbF26c0B4956C` on Etica, then running Permit2's deploy through it. Whatever address `CREATE` picks on first deploy is recorded in `docs/TRADING.md` Appendix B.
