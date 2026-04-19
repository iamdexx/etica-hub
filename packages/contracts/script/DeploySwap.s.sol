// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {EticaSwapFactory} from "../src/swap/EticaSwapFactory.sol";
import {EticaSwapRouter} from "../src/swap/EticaSwapRouter.sol";
import {WEGAZ} from "../src/swap/WEGAZ.sol";

/// @notice Deploys the EticaSwap V2 stack: WEGAZ, Factory, Router.
///         Use `TREASURY_ADDRESS` as the feeToSetter so the treasury controls
///         whether the 0.05% protocol fee is enabled.
///
/// Env vars:
///   DEPLOYER_PRIVATE_KEY  - private key of deployer (must have EGAZ for gas)
///   TREASURY_ADDRESS      - feeToSetter; also the default feeTo if enabled
contract DeploySwap is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address treasury = vm.envAddress("TREASURY_ADDRESS");

        vm.startBroadcast(pk);

        WEGAZ wegaz = new WEGAZ();
        EticaSwapFactory factory = new EticaSwapFactory(treasury);
        EticaSwapRouter router = new EticaSwapRouter(address(factory), address(wegaz));

        vm.stopBroadcast();

        console2.log("Chain ID:            ", block.chainid);
        console2.log("WEGAZ:               ", address(wegaz));
        console2.log("EticaSwapFactory:    ", address(factory));
        console2.log("EticaSwapRouter:     ", address(router));
        console2.log("feeToSetter/treasury:", treasury);
    }
}
