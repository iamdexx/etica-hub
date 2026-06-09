// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {EtomicSwap} from "../src/atomic-swap/EtomicSwap.sol";

/// @title DeployEtomicSwap
/// @notice Deploys the Komodo EtomicSwap HTLC contract on Etica (chain 61803).
///         This contract enables atomic swaps via the Komodo DeFi Framework.
///
/// Usage:
///   DEPLOYER_PRIVATE_KEY=0x... forge script script/DeployEtomicSwap.s.sol \
///     --rpc-url https://rpc2.etica-stats.org \
///     --broadcast --verify --verifier sourcify
contract DeployEtomicSwap is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(pk);

        EtomicSwap swap = new EtomicSwap();
        console2.log("EtomicSwap deployed at:", address(swap));

        vm.stopBroadcast();
    }
}
