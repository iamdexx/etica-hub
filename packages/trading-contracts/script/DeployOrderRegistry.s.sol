// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.0;

import {Script, console2} from "forge-std/Script.sol";
import {OrderRegistry} from "../src/OrderRegistry.sol";

/// @notice Standalone deploy script for the permissionless OrderRegistry.
///         No constructor args, no post-deploy wiring. The registry is a
///         pure public bulletin board — there's nothing to configure.
///
///         Deployer identity doesn't matter beyond paying gas; the
///         contract has no owner.
contract DeployOrderRegistry is Script {
    function run() external returns (OrderRegistry registry) {
        vm.startBroadcast();
        registry = new OrderRegistry();
        console2.log("OrderRegistry:", address(registry));
        vm.stopBroadcast();
    }
}
