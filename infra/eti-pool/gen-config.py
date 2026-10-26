#!/usr/bin/env python3
import json, re
env = dict(l.strip().split("=",1) for l in open("/root/.eti-pool.env") if "=" in l)
BATCHED_PAYMENTS = "0x2ab929Ab41b4ba22D66DDeAB075F615888fd050a"  # owner = payments wallet
info_path = "/opt/eti-pool/eticapool/config/DeployedContractInfo.json"
info = json.load(open(info_path))
info["networks"]["etica"]["contracts"]["batchedpayments"]["blockchain_address"] = BATCHED_PAYMENTS
json.dump(info, open(info_path, "w"), indent=2)
contract = BATCHED_PAYMENTS
raw = open("/opt/eti-pool/eticapool/pool.config.template.json").read()
raw = re.sub(r",(\s*[}\]])", r"\1", raw)
cfg = json.loads(raw)
for envname in ("staging","production"):
    c = cfg[envname]
    c["poolName"] = "EticaHub ETI pool"
    c["poolUrl"] = "https://etipool.eticahub.com"
    c["mintingConfig"].update({"poolTokenFee": 0.5, "publicAddress": env["ETI_MINT_ADDRESS"], "privateKey": env["ETI_MINT_KEY"], "web3Provider": "https://eticamainnet.eticascan.org"})
    c["paymentsConfig"].update({"publicAddress": env["ETI_PAY_ADDRESS"], "privateKey": env["ETI_PAY_KEY"], "web3Provider": "https://eticamainnet.eticascan.org", "poolRewardsBonus": 0})
json.dump(cfg, open("/opt/eti-pool/eticapool/pool.config.json","w"), indent=2)
print("ok contract", contract, "fee", cfg["production"]["mintingConfig"]["poolTokenFee"])
