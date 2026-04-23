// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {TreasuryHarvester} from "../../src/etx/TreasuryHarvester.sol";
import {StakedETX} from "../../src/etx/StakedETX.sol";
import {EticaSwapFactory} from "../../src/swap/EticaSwapFactory.sol";
import {EticaSwapRouter} from "../../src/swap/EticaSwapRouter.sol";
import {WEGAZ} from "../../src/swap/WEGAZ.sol";
import {IEticaSwapPair} from "../../src/swap/interfaces/IEticaSwapPair.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

contract MockRewardSink {
    uint256 public totalReceived;
    address public immutable asset;

    constructor(address _asset) {
        asset = _asset;
    }

    function distributeRewards(uint256 amount) external {
        totalReceived += amount;
        IERC20(asset).transferFrom(msg.sender, address(this), amount);
    }
}

contract TreasuryHarvesterTest is Test {
    address internal constant TREASURY = address(0x7EA5);
    address internal constant FEE_SETTER = address(0xFEE5E77E8);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant ATTACKER = address(0xBAD);

    uint256 internal constant ONE = 1e18;

    EticaSwapFactory internal factory;
    EticaSwapRouter internal router;
    WEGAZ internal wegaz;
    MockERC20 internal etx;
    MockERC20 internal eti;

    TreasuryHarvester internal harvester;
    StakedETX internal stVault;
    MockRewardSink internal farmsSink;

    IEticaSwapPair internal etiPair;
    IEticaSwapPair internal wegazPair;

    function setUp() public {
        // Core AMM infra.
        etx = new MockERC20("ETX (mock)", "ETX");
        factory = new EticaSwapFactory(FEE_SETTER, address(etx));
        wegaz = new WEGAZ();
        router = new EticaSwapRouter(address(factory), address(wegaz));
        eti = new MockERC20("Etica (mock)", "ETI");

        // Seed balances. Treasury gets the liquidity it will LP with.
        etx.mint(TREASURY, 1_000_000 * ONE);
        eti.mint(TREASURY, 500_000 * ONE);
        // Wrap some native into WEGAZ by minting directly to treasury via
        // deposit(): fund TREASURY with native, then wrap.
        vm.deal(TREASURY, 500_000 * ONE);

        // Bootstrap two pairs with treasury liquidity.
        vm.startPrank(TREASURY);
        etx.approve(address(router), type(uint256).max);
        eti.approve(address(router), type(uint256).max);
        wegaz.deposit{value: 500_000 * ONE}();
        IERC20(address(wegaz)).approve(address(router), type(uint256).max);

        // ETI/ETX pool, 200k/200k (spot price ~1).
        router.addLiquidity(
            address(etx),
            address(eti),
            200_000 * ONE,
            200_000 * ONE,
            0,
            0,
            TREASURY,
            block.timestamp + 1
        );
        // WEGAZ/ETX pool, 500k/300k (spot 1 ETX ~= 1.66 WEGAZ).
        router.addLiquidity(
            address(etx),
            address(wegaz),
            300_000 * ONE,
            500_000 * ONE,
            0,
            0,
            TREASURY,
            block.timestamp + 1
        );
        vm.stopPrank();

        etiPair = IEticaSwapPair(factory.getPair(address(etx), address(eti)));
        wegazPair = IEticaSwapPair(factory.getPair(address(etx), address(wegaz)));
        assertTrue(address(etiPair) != address(0));
        assertTrue(address(wegazPair) != address(0));
        assertGt(etiPair.balanceOf(TREASURY), 0);
        assertGt(wegazPair.balanceOf(TREASURY), 0);

        // Reward sinks.
        // Note: StakedETX requires an ERC20Metadata asset; MockERC20 has
        // decimals() returning 18 as a constant, but not as a virtual method
        // matching IERC20Metadata. The vault only uses decimals() + name() in
        // its own metadata setup, not the underlying's, so this works.
        stVault = new StakedETX(IERC20(address(etx)));
        farmsSink = new MockRewardSink(address(etx));

        // Deploy harvester owned by treasury. Harvest is permissionless;
        // no keeper EOA exists in the design.
        harvester = new TreasuryHarvester(TREASURY, address(etx), address(factory));

        // Treasury wires optional sinks and approves harvester for LP on both
        // pairs. We use unbounded approvals here; in production the treasury
        // may choose a fixed cap and top up periodically.
        vm.startPrank(TREASURY);
        harvester.setStakedEtx(address(stVault));
        harvester.setFarms(address(farmsSink));
        IERC20(address(etiPair)).approve(address(harvester), type(uint256).max);
        IERC20(address(wegazPair)).approve(address(harvester), type(uint256).max);
        vm.stopPrank();
    }

    // -------------------------------------------------------------------------
    // Constructor + defaults
    // -------------------------------------------------------------------------

    function test_constructor_setsFields() public view {
        assertEq(harvester.owner(), TREASURY);
        assertEq(harvester.etx(), address(etx));
        assertEq(address(harvester.factory()), address(factory));
        assertEq(harvester.maxBurnBpsPerRun(), 100);
        assertEq(harvester.stakedEtxBps(), 1_000);
        assertEq(harvester.farmsBps(), 1_000);
        assertEq(harvester.polBurnBps(), 4_000);
        assertEq(harvester.treasuryBps(), 4_000);
        assertEq(uint256(harvester.harvestCooldown()), 23 hours);
        assertEq(uint256(harvester.callerTipEtx()), 0);
        assertEq(uint256(harvester.lastHarvestAt()), 0);
    }

    function test_constructor_revertsOnZeroAddresses() public {
        vm.expectRevert(TreasuryHarvester.ZeroAddress.selector);
        new TreasuryHarvester(TREASURY, address(0), address(factory));

        vm.expectRevert(TreasuryHarvester.ZeroAddress.selector);
        new TreasuryHarvester(TREASURY, address(etx), address(0));
    }

    // -------------------------------------------------------------------------
    // Access control: admin
    // -------------------------------------------------------------------------

    function test_setHarvestCooldown_onlyOwner() public {
        vm.prank(ATTACKER);
        vm.expectRevert();
        harvester.setHarvestCooldown(1 hours);
    }

    function test_setHarvestCooldown_rejectsTooLong() public {
        uint32 maxCooldown = harvester.MAX_HARVEST_COOLDOWN();
        uint32 tooLong = maxCooldown + 1;
        vm.expectRevert(
            abi.encodeWithSelector(TreasuryHarvester.CooldownTooLong.selector, tooLong, maxCooldown)
        );
        vm.prank(TREASURY);
        harvester.setHarvestCooldown(tooLong);
    }

    function test_setHarvestCooldown_rotates() public {
        vm.prank(TREASURY);
        harvester.setHarvestCooldown(1 hours);
        assertEq(uint256(harvester.harvestCooldown()), 1 hours);
    }

    function test_setCallerTipEtx_onlyOwner() public {
        vm.prank(ATTACKER);
        vm.expectRevert();
        harvester.setCallerTipEtx(uint128(1 * ONE));
    }

    function test_setCallerTipEtx_rotates() public {
        vm.prank(TREASURY);
        harvester.setCallerTipEtx(uint128(5 * ONE));
        assertEq(uint256(harvester.callerTipEtx()), 5 * ONE);
    }

    function test_setSplit_mustSumTo10000() public {
        vm.prank(TREASURY);
        vm.expectRevert(TreasuryHarvester.BpsSumInvalid.selector);
        harvester.setSplit(1_000, 1_000, 4_000, 3_999);
    }

    function test_setSplit_ok() public {
        vm.prank(TREASURY);
        harvester.setSplit(2_500, 1_000, 3_000, 3_500);
        assertEq(harvester.stakedEtxBps(), 2_500);
        assertEq(harvester.farmsBps(), 1_000);
        assertEq(harvester.polBurnBps(), 3_000);
        assertEq(harvester.treasuryBps(), 3_500);
    }

    function test_setSplit_onlyOwner() public {
        vm.prank(ATTACKER);
        vm.expectRevert();
        harvester.setSplit(2_500, 2_500, 2_500, 2_500);
    }

    function test_setMaxBurnBps_rejectsOver10000() public {
        vm.prank(TREASURY);
        vm.expectRevert(TreasuryHarvester.BpsTooHigh.selector);
        harvester.setMaxBurnBpsPerRun(10_001);
    }

    function test_rescue_onlyOwner() public {
        vm.prank(ATTACKER);
        vm.expectRevert();
        harvester.rescue(address(etx), 1);
    }

    function test_rescue_sendsToTreasury() public {
        // Seed harvester with some dust.
        etx.mint(address(harvester), 42 * ONE);
        uint256 before_ = etx.balanceOf(TREASURY);
        vm.prank(TREASURY);
        harvester.rescue(address(etx), 42 * ONE);
        assertEq(etx.balanceOf(TREASURY), before_ + 42 * ONE);
        assertEq(etx.balanceOf(address(harvester)), 0);
    }

    // -------------------------------------------------------------------------
    // Permissionless harvest: any caller, subject to cooldown + cap
    // -------------------------------------------------------------------------

    function test_harvest_permissionless_anyCallerCanTrigger() public {
        // A wallet with no privileges should be able to crank the harvester.
        TreasuryHarvester.PoolPlan[] memory plans = _makeMinimalPlans();
        uint256 treasuryBefore = etx.balanceOf(TREASURY);
        vm.prank(ALICE);
        harvester.harvest(plans);
        assertGt(etx.balanceOf(TREASURY), treasuryBefore, "treasury slice missing");
    }

    function test_harvest_permissionless_attackerCanTrigger() public {
        // Even an explicitly-adversarial caller cannot cause bounded-on-chain
        // damage, so the contract must accept the call.
        TreasuryHarvester.PoolPlan[] memory plans = _makeMinimalPlans();
        vm.prank(ATTACKER);
        harvester.harvest(plans);
        assertEq(uint256(harvester.lastHarvestAt()), block.timestamp);
    }

    function test_harvest_cooldown_blocksRapidCalls() public {
        TreasuryHarvester.PoolPlan[] memory plans = _makeMinimalPlans();

        // First call succeeds (lastHarvestAt == 0).
        vm.prank(ALICE);
        harvester.harvest(plans);
        uint256 firstAt = block.timestamp;

        // Second call in the same block must revert with the next-allowed
        // timestamp in the error payload.
        vm.prank(BOB);
        vm.expectRevert(
            abi.encodeWithSelector(
                TreasuryHarvester.CooldownNotElapsed.selector, firstAt + 23 hours
            )
        );
        harvester.harvest(plans);
    }

    function test_harvest_cooldown_releasesAfterWindow() public {
        vm.prank(ALICE);
        harvester.harvest(_makeMinimalPlans());

        // Jump past the cooldown and re-run. Another caller should succeed.
        // Rebuild plans so lpToBurn is recomputed against the treasury's
        // now-smaller LP balance (cap shifts by 1% each run).
        vm.warp(block.timestamp + 23 hours + 1);
        vm.prank(BOB);
        harvester.harvest(_makeMinimalPlans());
        assertEq(uint256(harvester.lastHarvestAt()), block.timestamp);
    }

    function test_harvest_cooldown_ownerCanShorten() public {
        vm.prank(ALICE);
        harvester.harvest(_makeMinimalPlans());

        // Owner drops cooldown to 10s; post-window call succeeds.
        vm.prank(TREASURY);
        harvester.setHarvestCooldown(10);

        vm.warp(block.timestamp + 10 + 1);
        vm.prank(BOB);
        harvester.harvest(_makeMinimalPlans());
    }

    function test_harvest_rejectsEmptyPools() public {
        TreasuryHarvester.PoolPlan[] memory empty;
        vm.prank(ALICE);
        vm.expectRevert(TreasuryHarvester.NoPoolsProvided.selector);
        harvester.harvest(empty);
    }

    function test_harvest_callerTip_paidFromTreasurySlice() public {
        // Owner sets a 1 ETX tip. The caller should receive it out of the
        // retained treasury slice (so treasury + tip ~= original slice).
        uint128 tip = uint128(1 * ONE);
        vm.prank(TREASURY);
        harvester.setCallerTipEtx(tip);

        TreasuryHarvester.PoolPlan[] memory plans = _makeMinimalPlans();

        uint256 aliceEtxBefore = etx.balanceOf(ALICE);
        uint256 treasuryEtxBefore = etx.balanceOf(TREASURY);

        vm.prank(ALICE);
        harvester.harvest(plans);

        assertEq(etx.balanceOf(ALICE) - aliceEtxBefore, tip, "caller did not receive tip");
        // Treasury still gains ETX (retained slice was > tip).
        assertGt(etx.balanceOf(TREASURY), treasuryEtxBefore, "treasury net missing");
    }

    function test_harvest_callerTip_zeroByDefault() public {
        // Default tip is zero; caller should not receive any ETX.
        TreasuryHarvester.PoolPlan[] memory plans = _makeMinimalPlans();
        uint256 aliceEtxBefore = etx.balanceOf(ALICE);
        vm.prank(ALICE);
        harvester.harvest(plans);
        assertEq(etx.balanceOf(ALICE), aliceEtxBefore, "no tip should be paid by default");
    }

    // -------------------------------------------------------------------------
    // Harvest safety guards
    // -------------------------------------------------------------------------

    function test_harvest_rejectsLpOverCap() public {
        TreasuryHarvester.PoolPlan[] memory plans = _makeMinimalPlans();
        uint256 treasuryLp = etiPair.balanceOf(TREASURY);
        // 200 bps > the default 100 bps cap.
        plans[0].lpToBurn = (treasuryLp * 200) / 10_000;

        vm.prank(ALICE);
        vm.expectRevert(
            abi.encodeWithSelector(
                TreasuryHarvester.LpExceedsCap.selector,
                plans[0].lpToBurn,
                (treasuryLp * 100) / 10_000
            )
        );
        harvester.harvest(plans);
    }

    function test_harvest_rejectsInvalidPairRegistration() public {
        TreasuryHarvester.PoolPlan[] memory plans = new TreasuryHarvester.PoolPlan[](1);
        plans[0] = TreasuryHarvester.PoolPlan({
            pair: address(0xDEADBEEF),
            nonEtx: address(eti),
            lpToBurn: 1 * ONE,
            minEtxFromBurn: 0,
            minNonEtxFromBurn: 0,
            minEtxFromSwap: 0,
            polEtxForSwap: 0,
            polEtxForPair: 0,
            minNonEtxFromPolSwap: 0
        });
        vm.prank(ALICE);
        vm.expectRevert(TreasuryHarvester.InvalidPool.selector);
        harvester.harvest(plans);
    }

    function test_harvest_rejectsMismatchedNonEtx() public {
        // Use the ETI/ETX pair but claim nonEtx is wegaz → getPair lookup
        // will point at the wegaz pair, not the claimed pair.
        TreasuryHarvester.PoolPlan[] memory plans = new TreasuryHarvester.PoolPlan[](1);
        plans[0] = TreasuryHarvester.PoolPlan({
            pair: address(etiPair),
            nonEtx: address(wegaz),
            lpToBurn: 1 * ONE,
            minEtxFromBurn: 0,
            minNonEtxFromBurn: 0,
            minEtxFromSwap: 0,
            polEtxForSwap: 0,
            polEtxForPair: 0,
            minNonEtxFromPolSwap: 0
        });
        vm.prank(ALICE);
        vm.expectRevert(TreasuryHarvester.InvalidPool.selector);
        harvester.harvest(plans);
    }

    function test_harvest_rejectsSlippageOnBurn() public {
        TreasuryHarvester.PoolPlan[] memory plans = _makeMinimalPlans();
        plans[0].minEtxFromBurn = type(uint256).max; // impossible

        vm.prank(ALICE);
        vm.expectRevert(TreasuryHarvester.SlippageExceeded.selector);
        harvester.harvest(plans);
    }

    function test_harvest_rejectsSlippageOnSwap() public {
        TreasuryHarvester.PoolPlan[] memory plans = _makeMinimalPlans();
        plans[0].minEtxFromSwap = type(uint256).max; // impossible

        vm.prank(ALICE);
        vm.expectRevert(TreasuryHarvester.SlippageExceeded.selector);
        harvester.harvest(plans);
    }

    function test_harvest_rejectsUnevenPolPair() public {
        TreasuryHarvester.PoolPlan[] memory plans = _makeMinimalPlans();
        // Assign a swap side but no pair side → malformed POL branch.
        plans[0].polEtxForSwap = 100 * ONE;
        plans[0].polEtxForPair = 0;

        vm.prank(ALICE);
        vm.expectRevert(TreasuryHarvester.UnevenPolPair.selector);
        harvester.harvest(plans);
    }

    function test_harvest_rejectsOverAssignedPol() public {
        // With the default 10/10/40/40 split and tiny harvest amounts we can
        // cheaply over-spend the POL slice on purpose.
        TreasuryHarvester.PoolPlan[] memory plans = _makeMinimalPlans();
        plans[0].polEtxForSwap = type(uint128).max;
        plans[0].polEtxForPair = type(uint128).max;

        vm.prank(ALICE);
        vm.expectRevert();
        harvester.harvest(plans);
    }

    // -------------------------------------------------------------------------
    // Happy path
    // -------------------------------------------------------------------------

    function test_harvest_distributesSplitCorrectly() public {
        TreasuryHarvester.PoolPlan[] memory plans = _makeMinimalPlans();

        uint256 treasuryEtxBefore = etx.balanceOf(TREASURY);
        uint256 stVaultAssetsBefore = etx.balanceOf(address(stVault));
        uint256 farmsBefore = etx.balanceOf(address(farmsSink));
        uint256 deadLpEtiBefore = etiPair.balanceOf(harvester.DEAD());
        uint256 deadLpWegazBefore = wegazPair.balanceOf(harvester.DEAD());

        vm.prank(ALICE);
        harvester.harvest(plans);

        // stETX got ETX (balance grew).
        assertGt(etx.balanceOf(address(stVault)), stVaultAssetsBefore, "stETX slice missing");
        // Farms sink got ETX.
        assertGt(etx.balanceOf(address(farmsSink)), farmsBefore, "farms slice missing");
        // Treasury retained slice landed back in treasury wallet.
        assertGt(etx.balanceOf(TREASURY), treasuryEtxBefore, "treasury slice missing");
        // POL burn minted LP to DEAD on both pools.
        assertGt(etiPair.balanceOf(harvester.DEAD()), deadLpEtiBefore, "no POL LP on ETI pool");
        assertGt(
            wegazPair.balanceOf(harvester.DEAD()), deadLpWegazBefore, "no POL LP on WEGAZ pool"
        );

        // Harvester should be drained of ETX after a run.
        assertEq(etx.balanceOf(address(harvester)), 0, "ETX dust in harvester");
        // And of both non-ETX legs.
        assertEq(eti.balanceOf(address(harvester)), 0, "ETI dust in harvester");
        assertEq(IERC20(address(wegaz)).balanceOf(address(harvester)), 0, "WEGAZ dust in harvester");
    }

    function test_harvest_routesToTreasuryWhenSinksUnset() public {
        // Clear both sinks so those slices are retained.
        vm.startPrank(TREASURY);
        harvester.setStakedEtx(address(0));
        harvester.setFarms(address(0));
        vm.stopPrank();

        TreasuryHarvester.PoolPlan[] memory plans = _makeMinimalPlans();

        uint256 treasuryBefore = etx.balanceOf(TREASURY);
        uint256 stVaultBefore = etx.balanceOf(address(stVault));
        uint256 farmsBefore = etx.balanceOf(address(farmsSink));

        vm.prank(ALICE);
        harvester.harvest(plans);

        assertEq(etx.balanceOf(address(stVault)), stVaultBefore, "stVault should be untouched");
        assertEq(etx.balanceOf(address(farmsSink)), farmsBefore, "farms should be untouched");
        assertGt(
            etx.balanceOf(TREASURY), treasuryBefore, "treasury did not collect retained slices"
        );
    }

    function test_harvest_doesNotLeaveNonEtxDustOnSkippedPolBranch() public {
        // Skip POL branch entirely (no assignment) → the full POL slice
        // should be returned to treasury as ETX, nothing minted to DEAD.
        TreasuryHarvester.PoolPlan[] memory plans = _makeMinimalPlans();
        for (uint256 i = 0; i < plans.length; i++) {
            plans[i].polEtxForSwap = 0;
            plans[i].polEtxForPair = 0;
        }

        uint256 deadLpBefore = etiPair.balanceOf(harvester.DEAD());
        uint256 treasuryBefore = etx.balanceOf(TREASURY);

        vm.prank(ALICE);
        harvester.harvest(plans);

        assertEq(etiPair.balanceOf(harvester.DEAD()), deadLpBefore, "unexpected POL LP");
        assertGt(etx.balanceOf(TREASURY), treasuryBefore, "POL residual not returned");
        assertEq(etx.balanceOf(address(harvester)), 0);
    }

    function test_harvest_leavesNoAllowanceOnSinks() public {
        TreasuryHarvester.PoolPlan[] memory plans = _makeMinimalPlans();
        vm.prank(ALICE);
        harvester.harvest(plans);

        assertEq(
            IERC20(address(etx)).allowance(address(harvester), address(stVault)),
            0,
            "stETX allowance leak"
        );
        assertEq(
            IERC20(address(etx)).allowance(address(harvester), address(farmsSink)),
            0,
            "farms allowance leak"
        );
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    /// @dev Build a two-pool plan that burns 1% of treasury LP on each pool,
    ///      with no min-outs (so slippage guards are effectively off for the
    ///      happy-path tests). POL branch assigns half of the retained ETX
    ///      slice from each pool to itself, split 50/50.
    function _makeMinimalPlans() internal view returns (TreasuryHarvester.PoolPlan[] memory plans) {
        plans = new TreasuryHarvester.PoolPlan[](2);

        uint256 etiLp = (etiPair.balanceOf(TREASURY) * 100) / 10_000;
        uint256 wegazLp = (wegazPair.balanceOf(TREASURY) * 100) / 10_000;

        // We deliberately don't precompute the exact POL slice here — the
        // happy-path tests rely on the harvester's internal accounting to
        // return any residual to treasury. The per-pool POL legs we supply
        // are small enough to fit inside the eventual polSlice for any
        // reasonable harvest size.
        plans[0] = TreasuryHarvester.PoolPlan({
            pair: address(etiPair),
            nonEtx: address(eti),
            lpToBurn: etiLp,
            minEtxFromBurn: 0,
            minNonEtxFromBurn: 0,
            minEtxFromSwap: 0,
            polEtxForSwap: 10 * ONE,
            polEtxForPair: 10 * ONE,
            minNonEtxFromPolSwap: 0
        });
        plans[1] = TreasuryHarvester.PoolPlan({
            pair: address(wegazPair),
            nonEtx: address(wegaz),
            lpToBurn: wegazLp,
            minEtxFromBurn: 0,
            minNonEtxFromBurn: 0,
            minEtxFromSwap: 0,
            polEtxForSwap: 10 * ONE,
            polEtxForPair: 10 * ONE,
            minNonEtxFromPolSwap: 0
        });
    }
}
