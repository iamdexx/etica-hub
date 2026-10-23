# EticaSwap standalone V2 pools (USDC.e/EGAZ, USDC.e/ETI)

Plain Uniswap V2 factory with no link to the ETX hub: pairs hold their own
tokens, so price aggregators (GeckoTerminal, DefiLlama, …) index them as
ordinary V2 pools. Parity with the hub route (`asset → ETX → USDC.e`) is left to
routing (the swap card quotes both venues and takes the better one) and to the
runner's arbitrage. The pools are intentionally **not listed on EticaHub**
(`/pools`, `/api/v1/pairs`, sitemap); they are reachable only on-chain and
through the embeddable widget.

## Deployment (Etica mainnet, chain 61803, block 11045749)

| Contract | Address |
| --- | --- |
| `EticaV2Factory` | `0xbC09D5c67cF130F242dcC0B1dc303b068fb5c4F5` |
| `EticaSwapRouter` (bound to the factory) | `0x92588D96D84CE4A1Ae48c997c6C12d7b0E9eA6ab` |
| USDC.e/EGAZ pair | `0x55805916c68d85e869F1E9B18957dE7B711C748f` |
| USDC.e/ETI pair | `0x45a3DbEe2646AcE1C0419C638EFf58ed92C92c34` |

`feeToSetter` is the treasury wallet `0xB2B4bC9d02970A55efF64C2D84c622c87967C19D`.
`feeTo` is unset at deploy (LPs receive the full 0.30%); pointing it at the
treasury gives the same 0.25% LP / 0.05% protocol split as the hub.

Deploy txs: factory `0xca8f4ac6…f1ef`, router `0xcb195e3b…bbb5`,
createPair USDC.e/EGAZ `0xd997bb71…d538`, createPair USDC.e/ETI `0x4ae02fb1…bbee`,
setFeeToSetter `0x962676a1…58f9`. Both pairs were created empty; the first
deposit sets the opening price.

Pair init code hash: `factory.pairCodeHash()`; `createPair` is open to anyone
(standard V2), `setFeeTo` / `setFeeToSetter` are `feeToSetter`-only.

## Widget

`https://eticahub.com/embed/v2-pool?pair=egaz|eti&ref=0xHostWallet&theme=dark|light`

Bare page (no site chrome) meant for an `<iframe>`; swap and add-liquidity
against the pair with the visitor's own wallet. Every confirmed swap made
through a widget carrying `ref=` is posted to `/api/v1/widget/referrals`,
which re-reads the receipt on-chain and credits the host with the USDC.e
volume and the 0.30% fee it generated. The host's commission is
`REFERRAL_SHARE_OF_PROTOCOL_FEE` of the protocol's 1/6 fee share (0.025% of
volume at the default 50%), read back from
`GET /api/v1/widget/referrals?ref=0x…`; payouts are made from treasury fee
income.
