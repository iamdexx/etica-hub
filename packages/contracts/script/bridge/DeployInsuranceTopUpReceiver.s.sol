// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {InsuranceTopUpReceiver} from "../../src/bridge/InsuranceTopUpReceiver.sol";

/// @title DeployInsuranceTopUpReceiver
/// @notice Deploys the Etica-side audit-trail receiver for cross-chain insurance
///         top-up notices dispatched by `BridgeMinter` on Eth/BNB. Carries no
///         value; operator settles each `InsuranceTopUpNotice` off-chain and
///         calls `markSettled` to close it out.
///
/// Run AFTER both Etica + remote sides are deployed. Trusted senders are wired
/// via the timelocked `requestSetTrustedSender` flow (see ops runbook).
///
/// Env vars:
///   DEPLOYER_PRIVATE_KEY      deployer key
///   BRIDGE_OWNER              owner of receiver (typically same multisig as the rest)
///   HYPERLANE_MAILBOX_ETICA   Hyperlane mailbox on Etica
///   TOPUP_OP_TIMELOCK         seconds (e.g. 86400 = 24h)
contract DeployInsuranceTopUpReceiver is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address owner = vm.envAddress("BRIDGE_OWNER");
        address mailbox = vm.envAddress("HYPERLANE_MAILBOX_ETICA");
        uint64 opTimelock = uint64(vm.envUint("TOPUP_OP_TIMELOCK"));

        vm.startBroadcast(pk);

        InsuranceTopUpReceiver receiver = new InsuranceTopUpReceiver(owner, mailbox, opTimelock);

        vm.stopBroadcast();

        console2.log("== Insurance top-up receiver (Etica) ==");
        console2.log("Chain ID:                  ", block.chainid);
        console2.log("InsuranceTopUpReceiver:    ", address(receiver));
        console2.log("Owner:                     ", owner);
        console2.log("Hyperlane mailbox:         ", mailbox);
        console2.log("Op timelock (seconds):     ", opTimelock);
        console2.log("");
        console2.log("FOLLOW-UP (24h timelock per op):");
        console2.log("  receiver.requestSetTrustedSender(ETH_DOMAIN, <minter as bytes32>)");
        console2.log("  receiver.requestSetTrustedSender(BNB_DOMAIN, <minter as bytes32>)");
        console2.log("  And on each remote BridgeMinter:");
        console2.log("  minter.requestSetInsuranceTopUpTarget(ETICA_DOMAIN, <receiver as bytes32>)");
    }
}
