// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {BridgeMinter} from "../../src/bridge/BridgeMinter.sol";
import {OptimisticVetoModule} from "../../src/bridge/OptimisticVetoModule.sol";
import {FraudProverModule} from "../../src/bridge/FraudProverModule.sol";
import {HeartbeatISM} from "../../src/bridge/HeartbeatISM.sol";
import {TVLCapISM} from "../../src/bridge/TVLCapISM.sol";
import {RateLimitISM} from "../../src/bridge/RateLimitISM.sol";
import {IBridgeMinter} from "../../src/bridge/IBridgeMinter.sol";
import {IBridgeMinterTvlView} from "../../src/bridge/TVLCapISM.sol";
import {IBridgeMinterHeartbeatView} from "../../src/bridge/HeartbeatISM.sol";

/// @title DeployBridgeRemote
/// @notice Deploys the destination-chain (Eth/BNB) bridge stack: minter +
///         optimistic-veto module + fraud-prover module + the three custom
///         ISMs from PR 8c. `WrappedETX` is auto-deployed by `BridgeMinter`'s
///         constructor and its address is read back via `minter.wetx()`.
///
/// Order matches `docs/BRIDGE_CONTRACT_SPEC.md` §10:
///   1. BridgeMinter         (auto-deploys WrappedETX in ctor)
///   2. OptimisticVetoModule (wraps minter)
///   3. FraudProverModule    (wraps minter)
///   4. HeartbeatISM         (reads minter heartbeat state)
///   5. TVLCapISM            (reads minter TVL cap)
///   6. RateLimitISM         (stateful, owner-tunable)
///
/// Timelocked wireup (trusted vault on origin, allowed dest, veto authorities,
/// fraud-prover authority, ISM rotation) is performed post-deploy via the
/// `requestSet*` + 24h wait + `executeOp` flow. See BRIDGE_OPS_RUNBOOK.md.
///
/// Env vars:
///   DEPLOYER_PRIVATE_KEY       deployer key (must hold native gas)
///   BRIDGE_OWNER               owner of all contracts (multisig recommended)
///   HYPERLANE_MAILBOX_REMOTE   local Hyperlane mailbox (Eth or BNB)
///   SELF_DOMAIN                local Hyperlane domain ID (1 = Eth, 56 = BNB)
///   ETICA_DOMAIN               Etica Hyperlane domain ID (61803)
///   MINTER_OP_TIMELOCK         seconds (172800 = 48h per spec §5.2)
///   MODULE_OP_TIMELOCK         seconds (86400 = 24h)
///   ISM_OP_TIMELOCK            seconds for RateLimitISM (86400 = 24h)
///   TVL_CAP_ETX_WEI            initial wETX TVL ceiling
///   BOND_BPS                   bond per claim (2_500 = 25%)
///   BRIDGE_FEE_BPS             outbound burn fee (10 = 0.1%)
///   CHALLENGE_WINDOW_SECONDS   48h = 172_800
///   DAILY_MINT_CAP_BPS         500 = 5%
///   PER_CLAIM_CAP_BPS          100 = 1%
///   RATE_LIMIT_DAILY_CAP_WEI   wETX wei/day budget for RateLimitISM
contract DeployBridgeRemote is Script {
    struct MinterParams {
        address owner;
        address mailbox;
        uint32 selfDomain;
        uint64 opTimelock;
        uint128 tvlCap;
        uint16 bondBps;
        uint16 bridgeFeeBps;
        uint64 challengeWindow;
        uint128 dailyMintCapBps;
        uint128 perClaimCapBps;
    }

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(pk);

        BridgeMinter minter = _deployMinter();

        OptimisticVetoModule veto = new OptimisticVetoModule(
            vm.envAddress("BRIDGE_OWNER"),
            IBridgeMinter(address(minter)),
            uint64(vm.envUint("MODULE_OP_TIMELOCK"))
        );

        FraudProverModule prover = new FraudProverModule(
            vm.envAddress("BRIDGE_OWNER"),
            IBridgeMinter(address(minter)),
            vm.envAddress("HYPERLANE_MAILBOX_REMOTE"),
            uint32(vm.envUint("ETICA_DOMAIN")),
            uint64(vm.envUint("MODULE_OP_TIMELOCK"))
        );

        HeartbeatISM heartbeatIsm = new HeartbeatISM(IBridgeMinterHeartbeatView(address(minter)));

        TVLCapISM tvlIsm = new TVLCapISM(IBridgeMinterTvlView(address(minter)));

        RateLimitISM rateLimitIsm = new RateLimitISM(
            vm.envAddress("BRIDGE_OWNER"),
            vm.envAddress("HYPERLANE_MAILBOX_REMOTE"),
            uint128(vm.envUint("RATE_LIMIT_DAILY_CAP_WEI")),
            uint64(vm.envUint("ISM_OP_TIMELOCK"))
        );

        vm.stopBroadcast();

        _logDeploy(minter, veto, prover, heartbeatIsm, tvlIsm, rateLimitIsm);
    }

    function _deployMinter() internal returns (BridgeMinter) {
        MinterParams memory p = MinterParams({
            owner: vm.envAddress("BRIDGE_OWNER"),
            mailbox: vm.envAddress("HYPERLANE_MAILBOX_REMOTE"),
            selfDomain: uint32(vm.envUint("SELF_DOMAIN")),
            opTimelock: uint64(vm.envUint("MINTER_OP_TIMELOCK")),
            tvlCap: uint128(vm.envUint("TVL_CAP_ETX_WEI")),
            bondBps: uint16(vm.envUint("BOND_BPS")),
            bridgeFeeBps: uint16(vm.envUint("BRIDGE_FEE_BPS")),
            challengeWindow: uint64(vm.envUint("CHALLENGE_WINDOW_SECONDS")),
            dailyMintCapBps: uint128(vm.envUint("DAILY_MINT_CAP_BPS")),
            perClaimCapBps: uint128(vm.envUint("PER_CLAIM_CAP_BPS"))
        });

        return new BridgeMinter(
            p.owner,
            p.mailbox,
            p.selfDomain,
            p.opTimelock,
            p.tvlCap,
            p.bondBps,
            p.bridgeFeeBps,
            p.challengeWindow,
            p.dailyMintCapBps,
            p.perClaimCapBps
        );
    }

    function _logDeploy(
        BridgeMinter minter,
        OptimisticVetoModule veto,
        FraudProverModule prover,
        HeartbeatISM heartbeatIsm,
        TVLCapISM tvlIsm,
        RateLimitISM rateLimitIsm
    ) internal view {
        console2.log("== Remote-side bridge stack ==");
        console2.log("Chain ID:                 ", block.chainid);
        console2.log("BridgeMinter:             ", address(minter));
        console2.log("WrappedETX:               ", address(minter.wetx()));
        console2.log("OptimisticVetoModule:     ", address(veto));
        console2.log("FraudProverModule:        ", address(prover));
        console2.log("HeartbeatISM:             ", address(heartbeatIsm));
        console2.log("TVLCapISM:                ", address(tvlIsm));
        console2.log("RateLimitISM:             ", address(rateLimitIsm));
        console2.log("");
        console2.log("FOLLOW-UP (24-48h timelocks per op, see BRIDGE_OPS_RUNBOOK.md):");
        console2.log("  minter.requestSetVetoAuthority(address(veto))");
        console2.log("  minter.requestSetFraudProverAuthority(address(prover))");
        console2.log("  minter.requestSetTrustedVault(ETICA_DOMAIN, <vault as bytes32>)");
        console2.log("  minter.requestSetAllowedDestDomain(ETICA_DOMAIN, true)");
        console2.log("  minter.requestSetTreasuryRecipient(<treasury>)");
        console2.log("  minter.requestSetManualVetoerRewardRecipient(<vetoer payout>)");
        console2.log("  minter.requestSetInsuranceSweepRecipient(<sweep router>)");
        console2.log("  minter.requestSetHeartbeatSigner(<watcher bot key>)");
        console2.log("  prover.requestSetTrustedRootSender(<oracle as bytes32>)");
    }
}
