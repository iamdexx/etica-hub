package payouts

// Local payout signing: when POOL_PAYOUT_KEY (hex private key) is set, payouts are
// signed in-process and sent with eth_sendRawTransaction, so no account is ever
// unlocked on the node that also serves the public RPC.

import (
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

const payoutGasLimit = 21000

func localSigningEnabled() bool { return os.Getenv("POOL_PAYOUT_KEY") != "" }

// sendSignedPayout builds, signs and broadcasts a legacy transfer of amountWei to `to`.
func sendSignedPayout(r *rpc.RPCClient, from, to string, amountWei *big.Int, chainID int64) (string, error) {
	key, err := crypto.HexToECDSA(strings.TrimPrefix(os.Getenv("POOL_PAYOUT_KEY"), "0x"))
	if err != nil {
		return "", err
	}
	if !strings.EqualFold(crypto.PubkeyToAddress(key.PublicKey).Hex(), from) {
		return "", errors.New("POOL_PAYOUT_KEY does not match payouts.address")
	}
	nonce, err := r.GetPendingNonce(from)
	if err != nil {
		return "", err
	}
	gasPrice, err := r.GetGasPrice()
	if err != nil {
		return "", err
	}
	// 20% headroom so payouts don't sit in the pool when the floor moves.
	price := big.NewInt(gasPrice)
	price.Mul(price, big.NewInt(12))
	price.Div(price, big.NewInt(10))
	tx := types.NewTransaction(nonce, common.HexToAddress(to), amountWei, payoutGasLimit, price, nil)
	signed, err := types.SignTx(tx, types.NewEIP155Signer(big.NewInt(chainID)), key)
	if err != nil {
		return "", err
	}
	raw, err := signed.MarshalBinary()
	if err != nil {
		return "", err
	}
	return r.SendRawTransaction(hexutil.Encode(raw))
}
