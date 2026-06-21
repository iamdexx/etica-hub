// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {EtomicSwap} from "../src/atomic-swap/EtomicSwap.sol";

/// @title DeployEtomicSwap
/// @notice Deploys the Komodo EtomicSwap HTLC contract on Etica (chain 61803)
///         with 1% fee split equally to three immutable recipients.
///
/// Usage:
///   DEPLOYER_PRIVATE_KEY=0x... \
///   FEE_RECIPIENT_1=0x... \
///   FEE_RECIPIENT_2=0x... \
///   FEE_RECIPIENT_3=0x... \
///   forge script script/DeployEtomicSwap.s.sol \
///     --rpc-url https://rpc2.etica-stats.org \
///     --broadcast --verify --verifier sourcify
contract DeployEtomicSwap is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address payable r1 = payable(vm.envAddress("FEE_RECIPIENT_1"));
        address payable r2 = payable(vm.envAddress("FEE_RECIPIENT_2"));
        address payable r3 = payable(vm.envAddress("FEE_RECIPIENT_3"));

        vm.startBroadcast(pk);

        EtomicSwap swap = new EtomicSwap(r1, r2, r3);
        console2.log("EtomicSwap deployed at:", address(swap));
        console2.log("Fee recipient 1:", r1);
        console2.log("Fee recipient 2:", r2);
        console2.log("Fee recipient 3:", r3);
        console2.log("Fee: 1% (100 bps), split equally");

        vm.stopBroadcast();
    }
}
