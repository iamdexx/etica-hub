package payouts

// Optional "pay me in USDC.e" payouts. When PAYOUT_SWAPPER is set to the PayoutSwapper contract
// address and a miner has chosen payout mode "usdc" on the pool settings page, the payout is sent to
// the swapper, which wraps the EGAZ, swaps it on the standalone USDC.e/EGAZ pair and sends the USDC.e
// to the miner. If the swapper's quote fails or the swap would move the pool past its impact cap, the
// payout falls back to a plain EGAZ transfer so miners are never left unpaid.

import (
	"encoding/hex"
	"errors"
	"math/big"
	"os"
	"strings"

	"github.com/yuriy0803/core-geth1/common"
	"github.com/yuriy0803/core-geth1/common/hexutil"
	"github.com/yuriy0803/core-geth1/core/types"
	"github.com/yuriy0803/core-geth1/crypto"
	"github.com/yuriy0803/open-etc-pool-friends/rpc"
)

const (
	swapPayoutGasLimit = 300000
	swapSlippageBps    = 50 // minOut = quote - 0.5%
	PayoutModeEGAZ     = "egaz"
	PayoutModeUSDC     = "usdc"
)

var (
	// keccak256("quote(uint256)")[:4], keccak256("maxImpactBps()")[:4], keccak256("payInUsdc(address,uint256)")[:4]
	selQuote     = crypto.Keccak256([]byte("quote(uint256)"))[:4]
	selMaxImpact = crypto.Keccak256([]byte("maxImpactBps()"))[:4]
	selPayInUsdc = crypto.Keccak256([]byte("payInUsdc(address,uint256)"))[:4]
)

func swapperAddress() string { return strings.TrimSpace(os.Getenv("PAYOUT_SWAPPER")) }

func SwapPayoutsEnabled() bool { return common.IsHexAddress(swapperAddress()) }

func pad32(b []byte) []byte {
	out := make([]byte, 32)
	copy(out[32-len(b):], b)
	return out
}

func word(data []byte, i int) *big.Int {
	if len(data) < (i+1)*32 {
		return nil
	}
	return new(big.Int).SetBytes(data[i*32 : (i+1)*32])
}

// quoteSwap asks the swapper what the payout would return and whether it fits under the impact cap.
func quoteSwap(r *rpc.RPCClient, amountWei *big.Int) (minOut *big.Int, ok bool, err error) {
	to := swapperAddress()
	raw, err := r.Call(to, hexutil.Encode(append(append([]byte{}, selQuote...), pad32(amountWei.Bytes())...)))
	if err != nil {
		return nil, false, err
	}
	data, err := hex.DecodeString(strings.TrimPrefix(raw, "0x"))
	if err != nil {
		return nil, false, err
	}
	out, impact := word(data, 0), word(data, 1)
	if out == nil || impact == nil {
		return nil, false, errors.New("swapper quote: short response")
	}
	rawMax, err := r.Call(to, hexutil.Encode(selMaxImpact))
	if err != nil {
		return nil, false, err
	}
	maxData, err := hex.DecodeString(strings.TrimPrefix(rawMax, "0x"))
	if err != nil {
		return nil, false, err
	}
	maxImpact := word(maxData, 0)
	if maxImpact == nil {
		return nil, false, errors.New("swapper maxImpactBps: short response")
	}
	if out.Sign() <= 0 || impact.Cmp(maxImpact) > 0 {
		return nil, false, nil
	}
	minOut = new(big.Int).Mul(out, big.NewInt(10000-swapSlippageBps))
	minOut.Div(minOut, big.NewInt(10000))
	return minOut, true, nil
}

// sendSignedSwapPayout pays `amountWei` of EGAZ to `miner` as USDC.e via the swapper.
// swapped=false with a nil error means the caller must fall back to a plain EGAZ payout.
func sendSignedSwapPayout(r *rpc.RPCClient, from, miner string, amountWei *big.Int, chainID int64) (txHash string, swapped bool, err error) {
	if !SwapPayoutsEnabled() {
		return "", false, nil
	}
	minOut, ok, err := quoteSwap(r, amountWei)
	if err != nil || !ok {
		return "", false, err
	}
	key, err := crypto.HexToECDSA(strings.TrimPrefix(os.Getenv("POOL_PAYOUT_KEY"), "0x"))
	if err != nil {
		return "", false, err
	}
	if !strings.EqualFold(crypto.PubkeyToAddress(key.PublicKey).Hex(), from) {
		return "", false, errors.New("POOL_PAYOUT_KEY does not match payouts.address")
	}
	nonce, err := r.GetPendingNonce(from)
	if err != nil {
		return "", false, err
	}
	gasPrice, err := r.GetGasPrice()
	if err != nil {
		return "", false, err
	}
	price := big.NewInt(gasPrice)
	price.Mul(price, big.NewInt(12))
	price.Div(price, big.NewInt(10))
	data := append([]byte{}, selPayInUsdc...)
	data = append(data, pad32(common.HexToAddress(miner).Bytes())...)
	data = append(data, pad32(minOut.Bytes())...)
	tx := types.NewTransaction(nonce, common.HexToAddress(swapperAddress()), amountWei, swapPayoutGasLimit, price, data)
	signed, err := types.SignTx(tx, types.NewEIP155Signer(big.NewInt(chainID)), key)
	if err != nil {
		return "", false, err
	}
	rawTx, err := signed.MarshalBinary()
	if err != nil {
		return "", false, err
	}
	txHash, err = r.SendRawTransaction(hexutil.Encode(rawTx))
	if err != nil {
		return "", false, err
	}
	return txHash, true, nil
}
