// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ResearchSubscription} from "../src/research/ResearchSubscription.sol";

/// @notice Deploys Phase 2 contracts: ResearchSubscription.
///
/// Env vars:
///   DEPLOYER_PRIVATE_KEY  - signer (funded with EGAZ for gas)
///   ETI_ADDRESS           - Etica core / ETI token address
///   TREASURY_ADDRESS      - subscription proceeds recipient + owner
///   SUB_PRICE_ETI_WEI     - price per month in ETI wei (e.g. 5e18)
contract DeployResearch is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address eti = vm.envAddress("ETI_ADDRESS");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        uint256 price = vm.envUint("SUB_PRICE_ETI_WEI");

        vm.startBroadcast(pk);
        ResearchSubscription sub = new ResearchSubscription(IERC20(eti), treasury, price, treasury);
        vm.stopBroadcast();

        console2.log("Chain ID:              ", block.chainid);
        console2.log("ResearchSubscription:  ", address(sub));
        console2.log("ETI:                   ", eti);
        console2.log("treasury/owner:        ", treasury);
        console2.log("price per month (wei): ", price);
    }
}
