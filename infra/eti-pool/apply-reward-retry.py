#!/usr/bin/env python3
"""Patch eticapool's rewardCrawl so a mint is retried, not skipped, when the pool balance is stale.

Upstream marks a pool mint as processed (poolstatus 2) even when every miner was skipped with
status 5 ("pool balance too low"). Right after a mint the cached BatchedPayments balance is
still 0 (the ETI sweep lands a few blocks later), so the first block of a fresh pool paid nobody.
This refreshes the balance before rewarding and keeps the mint at poolstatus 1 until it pays.

Usage: python3 apply-reward-retry.py /opt/eti-pool/eticapool   (idempotent)
"""
import sys
from pathlib import Path

root = Path(sys.argv[1] if len(sys.argv) > 1 else "/opt/eti-pool/eticapool")
path = root / "lib" / "transaction-coordinator.js"
src = path.read_text()
MARK = "eticahub: reward retry"
if MARK in src:
    print("already patched")
    sys.exit(0)

old_loop = "    for(let onepoolmint of unprocessedPoolmints)\n    {\n"
new_loop = old_loop + f"""     // {MARK}: use a fresh balance, and wait for the mint's ETI to land before rewarding.
     await TokenDataHelper.collectPoolAccountBalances(poolConfig, mongoInterface);
     var _freshBalances = await TokenDataHelper.getPoolAccountBalancesData(mongoInterface);
     var _tokenBalanceBN = web3utils.toBN(String(_freshBalances.paymentsAccountBalances['token'] || '0'));
     if (_tokenBalanceBN.lt(web3utils.toBN(String(poolConfig.paymentsConfig.PoolSecurityBalance)))) {{
       console.log('rewardCrawl: pool balance below PoolSecurityBalance, retrying mint ' + onepoolmint.epochCount + ' next cycle');
       continue;
     }}
"""
assert src.count(old_loop) == 1, "rewardCrawl loop not found"
src = src.replace(old_loop, new_loop)

old_done = "            await mongoInterface.updateOne('pool_mints', {_id: onepoolmint._id}, {poolstatus: 2});\n"
new_done = f"""            // {MARK}: miners skipped for low balance (status 5) get another pass next cycle.
            var _skipped = await mongoInterface.findAll('miner_challengediff', {{challengeNumber: _miningContractData.challengeNumber, status: 5}});
            if (_skipped && _skipped.length > 0) {{
              for (let _s of _skipped) {{
                await mongoInterface.updateOne('miner_challengediff', {{_id: _s._id}}, {{status: 1}});
              }}
              console.log('rewardCrawl: ' + _skipped.length + ' miners skipped for low balance on mint ' + onepoolmint.epochCount + ', will retry');
            }} else {{
              await mongoInterface.updateOne('pool_mints', {{_id: onepoolmint._id}}, {{poolstatus: 2}});
            }}
"""
assert src.count(old_done) == 1, "poolstatus 2 update not found"
src = src.replace(old_done, new_done)
path.write_text(src)
print("patched", path)
