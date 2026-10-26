#!/usr/bin/env python3
"""Patch open-etc-pool-friends so payouts are signed in-process (POOL_PAYOUT_KEY)
instead of via eth_sendTransaction on an unlocked node account. Run from the pool
source root; idempotent. Also copies signer.go into payouts/."""
import os, shutil, sys

here = os.path.dirname(os.path.abspath(__file__))
shutil.copy(os.path.join(here, "signer.go"), "payouts/signer.go")

p = "rpc/rpc.go"; s = open(p).read()
if "GetPendingNonce" not in s:
    s = s.replace("func (r *RPCClient) SendTransaction(", '''func (r *RPCClient) GetPendingNonce(address string) (uint64, error) {
	rpcResp, err := r.doPost(r.Url, "eth_getTransactionCount", []string{address, "pending"})
	if err != nil {
		return 0, err
	}
	var reply string
	if err := json.Unmarshal(*rpcResp.Result, &reply); err != nil {
		return 0, err
	}
	return strconv.ParseUint(strings.Replace(reply, "0x", "", -1), 16, 64)
}

func (r *RPCClient) SendRawTransaction(rawTx string) (string, error) {
	rpcResp, err := r.doPost(r.Url, "eth_sendRawTransaction", []string{rawTx})
	var reply string
	if err != nil {
		return reply, err
	}
	if err := json.Unmarshal(*rpcResp.Result, &reply); err != nil {
		return reply, err
	}
	if util.IsZeroHash(reply) {
		err = errors.New("transaction is not yet available")
	}
	return reply, err
}

func (r *RPCClient) SendTransaction(''', 1)
    open(p, "w").write(s)

p = "payouts/payer.go"; s = open(p).read()
if "ChainID" not in s:
    s = s.replace('\tBgSave    bool  `json:"bgsave"`\n', '\tBgSave    bool  `json:"bgsave"`\n\tChainID   int64 `json:"chainId"`\n', 1)
    old = "\t\ttxHash, err := u.rpc.SendTransaction(u.config.Address, login, u.config.GasHex(), u.config.GasPriceHex(), value, u.config.AutoGas)\n"
    assert old in s, "SendTransaction call not found"
    # Always sign locally: never fall back to eth_sendTransaction, which would need an unlocked account on the RPC node.
    s = s.replace(old, "\t\t_ = value\n\t\ttxHash, err := sendSignedPayout(u.rpc, u.config.Address, login, amountInWei, u.config.ChainID)\n", 1)
    unlock = "\t\tif !u.isUnlockedAccount() {\n"
    assert unlock in s, "isUnlockedAccount check not found"
    s = s.replace(unlock, "\t\tif !localSigningEnabled() {\n\t\t\tlog.Println(\"Unable to process payouts: POOL_PAYOUT_KEY is not set\")\n", 1)
    start = "\tlog.Println(\"Starting payouts\")\n"
    assert start in s
    s = s.replace(start, start + "\tif !localSigningEnabled() {\n\t\tlog.Fatal(\"POOL_PAYOUT_KEY is required: payouts are signed in-process, never by the RPC node\")\n\t}\n", 1)
    open(p, "w").write(s)
print("patched")
