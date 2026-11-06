#!/usr/bin/env python3
"""Patch open-etc-pool-friends (after apply-local-signing.py) so miners can opt in to USDC.e payouts
through the PayoutSwapper contract (PAYOUT_SWAPPER env). Run from the pool source root; idempotent.
Also copies swapper.go into payouts/."""
import os, shutil

here = os.path.dirname(os.path.abspath(__file__))
shutil.copy(os.path.join(here, "swapper.go"), "payouts/swapper.go")

p = "rpc/rpc.go"; s = open(p).read()
if "func (r *RPCClient) Call(" not in s:
    anchor = "func (r *RPCClient) SendRawTransaction("
    assert anchor in s
    s = s.replace(anchor, '''func (r *RPCClient) Call(to, data string) (string, error) {
	rpcResp, err := r.doPost(r.Url, "eth_call", []interface{}{map[string]string{"to": to, "data": data}, "latest"})
	if err != nil {
		return "", err
	}
	var reply string
	if err := json.Unmarshal(*rpcResp.Result, &reply); err != nil {
		return "", err
	}
	return reply, nil
}

''' + anchor, 1)
    open(p, "w").write(s)

p = "storage/redis.go"; s = open(p).read()
if "GetPayoutMode" not in s:
    anchor = "func (r *RedisClient) SetThreshold("
    assert anchor in s
    s = s.replace(anchor, '''func (r *RedisClient) GetPayoutMode(login string) string {
	mode, err := r.client.HGet(r.formatKey("settings", login), "payoutmode").Result()
	if err != nil || mode == "" {
		return "egaz"
	}
	return mode
}

func (r *RedisClient) SetPayoutMode(login string, mode string) error {
	return r.client.HSet(r.formatKey("settings", login), "payoutmode", mode).Err()
}

''' + anchor, 1)
    open(p, "w").write(s)

p = "api/server.go"; s = open(p).read()
if "SetPayoutMode" not in s:
    old = "\t\ts.backend.SetThreshold(login, int64(number*shannon))\n"
    assert old in s, "SetThreshold call not found in SubscribeHandler"
    s = s.replace(old, old + '''		if payout := r.FormValue("payout"); payout == "usdc" || payout == "egaz" {
			s.backend.SetPayoutMode(login, payout)
		}
''', 1)
    open(p, "w").write(s)

p = "payouts/payer.go"; s = open(p).read()
if "sendSignedSwapPayout" not in s:
    old = "\t\ttxHash, err := sendSignedPayout(u.rpc, u.config.Address, login, amountInWei, u.config.ChainID)\n"
    assert old in s, "sendSignedPayout call not found (run apply-local-signing.py first)"
    s = s.replace(old, '''		var txHash string
		swapped := false
		if u.backend.GetPayoutMode(login) == PayoutModeUSDC {
			txHash, swapped, err = sendSignedSwapPayout(u.rpc, u.config.Address, login, amountInWei, u.config.ChainID)
			if err != nil {
				log.Printf("USDC.e payout for %s failed before sending, paying EGAZ instead: %v", login, err)
				err = nil
			} else if swapped {
				log.Printf("Paid %s in USDC.e via swapper, tx %s", login, txHash)
			} else {
				log.Printf("USDC.e payout for %s skipped (swapper disabled or pool too shallow), paying EGAZ", login)
			}
		}
		if !swapped {
			txHash, err = sendSignedPayout(u.rpc, u.config.Address, login, amountInWei, u.config.ChainID)
		}
''', 1)
    open(p, "w").write(s)
print("patched payout swap")
