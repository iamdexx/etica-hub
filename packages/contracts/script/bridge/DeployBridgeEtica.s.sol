// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BridgeInsuranceFund} from "../../src/bridge/BridgeInsuranceFund.sol";
import {FeeRouter} from "../../src/bridge/FeeRouter.sol";
import {BridgeVault} from "../../src/bridge/BridgeVault.sol";

/// @title DeployBridgeEtica
/// @notice Deploys the Etica-side bridge stack (insurance fund, fee router,
///         vault) and wires the one-time `setBridgeVault` setters in a single
///         broadcast. Timelocked configuration (allowed dest domains, trusted
///         minters, veto authority, etc.) is left to a follow-up
///         `requestSet*` + 24h wait + `executeOp` flow documented in
///         `docs/BRIDGE_OPS_RUNBOOK.md`.
///
/// Order matches `docs/BRIDGE_CONTRACT_SPEC.md` §10:
///   1. BridgeInsuranceFund (depends on: ETX)
///   2. FeeRouter           (depends on: ETX, insurance fund, harvester)
///   3. BridgeVault         (depends on: ETX, mailbox, insurance fund, fee router)
///   4. setBridgeVault on insurance fund + fee router (one-time, non-timelocked)
///
/// Env vars:
///   DEPLOYER_PRIVATE_KEY       deployer key (must hold EGAZ for gas)
///   BRIDGE_OWNER               owner of all three contracts (typically a multisig)
///   ETX_ADDRESS                ETX ERC20 on Etica
///   HYPERLANE_MAILBOX_ETICA    Hyperlane mailbox on Etica
///   ETICA_DOMAIN               local Hyperlane domain ID (61803)
///   HARVESTER_ADDRESS          TreasuryHarvester (recipient of FeeRouter's 80% slice)
///   INSURANCE_WITHDRAW_TIMELOCK seconds (e.g. 172800 = 48h)
///   FEE_ROUTER_SPLIT_TIMELOCK   seconds (e.g. 86400 = 24h)
///   VAULT_OP_TIMELOCK           seconds (e.g. 172800 = 48h per spec §3)
contract DeployBridgeEtica is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address owner = vm.envAddress("BRIDGE_OWNER");
        IERC20 etx = IERC20(vm.envAddress("ETX_ADDRESS"));
        address mailbox = vm.envAddress("HYPERLANE_MAILBOX_ETICA");
        uint32 selfDomain = uint32(vm.envUint("ETICA_DOMAIN"));
        address harvester = vm.envAddress("HARVESTER_ADDRESS");
        uint64 insWithdrawTimelock = uint64(vm.envUint("INSURANCE_WITHDRAW_TIMELOCK"));
        uint64 feeSplitTimelock = uint64(vm.envUint("FEE_ROUTER_SPLIT_TIMELOCK"));
        uint64 vaultOpTimelock = uint64(vm.envUint("VAULT_OP_TIMELOCK"));

        vm.startBroadcast(pk);

        BridgeInsuranceFund insurance = new BridgeInsuranceFund(etx, owner, insWithdrawTimelock);

        FeeRouter feeRouter = new FeeRouter(etx, owner, insurance, harvester, feeSplitTimelock);

        BridgeVault vault =
            new BridgeVault(owner, etx, mailbox, insurance, feeRouter, selfDomain, vaultOpTimelock);

        // One-time setters (non-timelocked, locked-once). Must be called by
        // `owner`; if the deployer is also the owner the broadcast handles it
        // here, otherwise the operator runs these two txs separately from
        // their `BRIDGE_OWNER` account.
        if (msg.sender == owner) {
            insurance.setBridgeVault(address(vault));
            feeRouter.setBridgeVault(address(vault));
        }

        vm.stopBroadcast();

        console2.log("== Etica-side bridge stack ==");
        console2.log("Chain ID:                 ", block.chainid);
        console2.log("BridgeInsuranceFund:      ", address(insurance));
        console2.log("FeeRouter:                ", address(feeRouter));
        console2.log("BridgeVault:              ", address(vault));
        console2.log("Owner:                    ", owner);
        console2.log("ETX:                      ", address(etx));
        console2.log("Hyperlane mailbox:        ", mailbox);
        console2.log("Self domain:              ", selfDomain);
        console2.log("Harvester:                ", harvester);

        if (msg.sender != owner) {
            console2.log("");
            console2.log("NEXT: from BRIDGE_OWNER, call:");
            console2.log("  insurance.setBridgeVault(vault)");
            console2.log("  feeRouter.setBridgeVault(vault)");
        }
        console2.log("");
        console2.log("FOLLOW-UP (24h timelock per op, see BRIDGE_OPS_RUNBOOK.md):");
        console2.log("  vault.requestSetVetoAuthority(<watcher bot key>)");
        console2.log("  vault.requestSetAllowedDestDomain(ETH_DOMAIN, true)");
        console2.log("  vault.requestSetAllowedDestDomain(BNB_DOMAIN, true)");
        console2.log("  vault.requestSetTrustedMinter(ETH_DOMAIN, <minter>)");
        console2.log("  vault.requestSetTrustedMinter(BNB_DOMAIN, <minter>)");
    }
}
