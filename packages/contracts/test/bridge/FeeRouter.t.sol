// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {FeeRouter} from "../../src/bridge/FeeRouter.sol";
import {BridgeInsuranceFund} from "../../src/bridge/BridgeInsuranceFund.sol";
import {ETXToken} from "../../src/etx/ETXToken.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract FeeRouterTest is Test {
    ETXToken internal etx;
    BridgeInsuranceFund internal fund;
    FeeRouter internal router;

    address internal constant OWNER = address(0x0117E2);
    address internal constant TREASURY = address(0x77E45);
    address internal constant VAULT = address(0xA17_BEEF);
    address internal constant HARVESTER = address(0x4A4E57);
    address internal constant ATTACKER = address(0xBAD);

    uint64 internal constant FUND_TIMELOCK = 30 days;
    uint64 internal constant SPLIT_TIMELOCK = 24 hours;
    uint256 internal constant ONE = 1e18;

    function setUp() public {
        etx = new ETXToken(TREASURY);
        fund = new BridgeInsuranceFund(IERC20(address(etx)), OWNER, FUND_TIMELOCK);
        router = new FeeRouter(IERC20(address(etx)), OWNER, fund, HARVESTER, SPLIT_TIMELOCK);

        // Wire vault on both contracts so the fund will accept deposits from
        // anyone (deposit is permissionless) and the router will accept
        // routeFee from VAULT.
        vm.prank(OWNER);
        fund.setBridgeVault(VAULT);
        vm.prank(OWNER);
        router.setBridgeVault(VAULT);
    }

    function _seedRouter(uint128 amount) internal {
        // Treasury holds total supply; transfer to router as if vault forwarded.
        vm.prank(TREASURY);
        etx.transfer(address(router), amount);
    }

    /* -------------------------------------------------------------------- */
    /*                            CONSTRUCTOR                               */
    /* -------------------------------------------------------------------- */

    function test_constructor_setsImmutables() public view {
        assertEq(address(router.etx()), address(etx));
        assertEq(router.owner(), OWNER);
        assertEq(address(router.insuranceFund()), address(fund));
        assertEq(router.harvester(), HARVESTER);
        assertEq(router.splitTimelock(), SPLIT_TIMELOCK);
        assertEq(router.toInsuranceBps(), 2000);
        assertEq(router.toHarvesterBps(), 8000);
    }

    function test_constructor_grantsMaxAllowanceToFund() public view {
        assertEq(etx.allowance(address(router), address(fund)), type(uint256).max);
    }

    function test_constructor_revertsOnZeroEtx() public {
        vm.expectRevert(FeeRouter.FeeRouter_ZeroAddress.selector);
        new FeeRouter(IERC20(address(0)), OWNER, fund, HARVESTER, SPLIT_TIMELOCK);
    }

    function test_constructor_revertsOnZeroOwner() public {
        // Ownable rejects zero owner first.
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new FeeRouter(IERC20(address(etx)), address(0), fund, HARVESTER, SPLIT_TIMELOCK);
    }

    function test_constructor_revertsOnZeroInsuranceFund() public {
        vm.expectRevert(FeeRouter.FeeRouter_ZeroAddress.selector);
        new FeeRouter(
            IERC20(address(etx)), OWNER, BridgeInsuranceFund(address(0)), HARVESTER, SPLIT_TIMELOCK
        );
    }

    function test_constructor_revertsOnZeroHarvester() public {
        vm.expectRevert(FeeRouter.FeeRouter_ZeroAddress.selector);
        new FeeRouter(IERC20(address(etx)), OWNER, fund, address(0), SPLIT_TIMELOCK);
    }

    /* -------------------------------------------------------------------- */
    /*                          BRIDGE-VAULT WIRE                           */
    /* -------------------------------------------------------------------- */

    function test_setBridgeVault_revertsIfAlreadySet() public {
        vm.prank(OWNER);
        vm.expectRevert(FeeRouter.FeeRouter_VaultAlreadySet.selector);
        router.setBridgeVault(address(0xDEAD));
    }

    function test_setBridgeVault_revertsOnZero() public {
        FeeRouter fresh =
            new FeeRouter(IERC20(address(etx)), OWNER, fund, HARVESTER, SPLIT_TIMELOCK);
        vm.prank(OWNER);
        vm.expectRevert(FeeRouter.FeeRouter_ZeroAddress.selector);
        fresh.setBridgeVault(address(0));
    }

    function test_setBridgeVault_revertsForNonOwner() public {
        FeeRouter fresh =
            new FeeRouter(IERC20(address(etx)), OWNER, fund, HARVESTER, SPLIT_TIMELOCK);
        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, ATTACKER)
        );
        fresh.setBridgeVault(VAULT);
    }

    /* -------------------------------------------------------------------- */
    /*                              ROUTING                                 */
    /* -------------------------------------------------------------------- */

    function test_routeFee_splitsCorrectly_default20_80() public {
        uint128 amount = uint128(1000 * ONE);
        _seedRouter(amount);

        vm.expectEmit(false, false, false, true, address(router));
        emit FeeRouter.FeeRouted(amount, uint128(200 * ONE), uint128(800 * ONE));
        vm.prank(VAULT);
        router.routeFee(amount);

        assertEq(fund.balance(), 200 * ONE);
        assertEq(etx.balanceOf(HARVESTER), 800 * ONE);
        assertEq(etx.balanceOf(address(router)), 0);
    }

    function test_routeFee_revertsForNonVault() public {
        _seedRouter(uint128(100 * ONE));
        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(FeeRouter.FeeRouter_OnlyBridgeVault.selector, ATTACKER)
        );
        router.routeFee(uint128(100 * ONE));
    }

    function test_routeFee_revertsForOwner() public {
        _seedRouter(uint128(100 * ONE));
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(FeeRouter.FeeRouter_OnlyBridgeVault.selector, OWNER));
        router.routeFee(uint128(100 * ONE));
    }

    function test_routeFee_revertsOnInsufficientBalance() public {
        _seedRouter(uint128(50 * ONE));
        vm.prank(VAULT);
        vm.expectRevert(
            abi.encodeWithSelector(
                FeeRouter.FeeRouter_InsufficientBalance.selector, 100 * ONE, 50 * ONE
            )
        );
        router.routeFee(uint128(100 * ONE));
    }

    function test_routeFee_zeroAmountIsNoop() public {
        vm.expectEmit(false, false, false, true, address(router));
        emit FeeRouter.FeeRouted(0, 0, 0);
        vm.prank(VAULT);
        router.routeFee(0);
        assertEq(fund.balance(), 0);
        assertEq(etx.balanceOf(HARVESTER), 0);
    }

    function test_routeFee_dustGoesToHarvester() public {
        // 7 wei split 20/80 → insurance = floor(7*2000/10000) = 1, harvester = 6
        // Dust never sticks in the router.
        uint128 amount = 7;
        _seedRouter(amount);
        vm.prank(VAULT);
        router.routeFee(amount);

        assertEq(fund.balance(), 1);
        assertEq(etx.balanceOf(HARVESTER), 6);
        assertEq(etx.balanceOf(address(router)), 0);
    }

    function testFuzz_routeFee_neverLeavesDust(uint128 amount) public {
        amount = uint128(bound(amount, 1, 1_000_000_000 * ONE));
        // Treasury can fund up to its balance (50M ETX initial).
        vm.assume(amount <= etx.balanceOf(TREASURY));
        _seedRouter(amount);

        vm.prank(VAULT);
        router.routeFee(amount);

        // Insurance + harvester == amount, router holds nothing.
        assertEq(fund.balance() + etx.balanceOf(HARVESTER), amount);
        assertEq(etx.balanceOf(address(router)), 0);
    }

    function test_routeFee_appliesUpdatedSplit() public {
        // Owner shifts to 50/50.
        vm.prank(OWNER);
        uint256 id = router.requestSplitChange(5000, 5000);
        vm.warp(block.timestamp + SPLIT_TIMELOCK);
        vm.prank(OWNER);
        router.executeSplitChange(id);

        uint128 amount = uint128(1000 * ONE);
        _seedRouter(amount);
        vm.prank(VAULT);
        router.routeFee(amount);

        assertEq(fund.balance(), 500 * ONE);
        assertEq(etx.balanceOf(HARVESTER), 500 * ONE);
    }

    /* -------------------------------------------------------------------- */
    /*                       SPLIT-CHANGE FLOW                              */
    /* -------------------------------------------------------------------- */

    function test_requestSplitChange_storesAndEmits() public {
        vm.prank(OWNER);
        vm.expectEmit(true, false, false, true, address(router));
        emit FeeRouter.SplitChangeRequested(0, 3000, 7000, uint64(block.timestamp) + SPLIT_TIMELOCK);
        uint256 id = router.requestSplitChange(3000, 7000);
        assertEq(id, 0);
        assertEq(router.nextSplitId(), 1);
    }

    function test_requestSplitChange_revertsIfBpsDontSumTo10000() public {
        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(FeeRouter.FeeRouter_InvalidSplit.selector, 3000, 6000)
        );
        router.requestSplitChange(3000, 6000);
    }

    function test_requestSplitChange_acceptsExtremeButValidSplits() public {
        // 100% to insurance is allowed (defensive ramp-up if backstop drained)
        vm.prank(OWNER);
        router.requestSplitChange(10_000, 0);
        // 100% to harvester is allowed
        vm.prank(OWNER);
        router.requestSplitChange(0, 10_000);
    }

    function test_requestSplitChange_revertsForNonOwner() public {
        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, ATTACKER)
        );
        router.requestSplitChange(5000, 5000);
    }

    function test_executeSplitChange_succeedsAfterTimelock() public {
        vm.prank(OWNER);
        uint256 id = router.requestSplitChange(3000, 7000);

        vm.warp(block.timestamp + SPLIT_TIMELOCK);

        vm.expectEmit(false, false, false, true, address(router));
        emit FeeRouter.SplitChanged(3000, 7000);
        vm.prank(OWNER);
        router.executeSplitChange(id);

        assertEq(router.toInsuranceBps(), 3000);
        assertEq(router.toHarvesterBps(), 7000);
    }

    function test_executeSplitChange_revertsBeforeTimelock() public {
        vm.prank(OWNER);
        uint256 id = router.requestSplitChange(3000, 7000);

        vm.warp(block.timestamp + SPLIT_TIMELOCK - 1);
        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(
                FeeRouter.FeeRouter_TimelockNotElapsed.selector,
                uint64(block.timestamp + 1),
                uint64(block.timestamp)
            )
        );
        router.executeSplitChange(id);
    }

    function test_executeSplitChange_revertsOnInvalidId() public {
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(FeeRouter.FeeRouter_InvalidSplitId.selector, 99));
        router.executeSplitChange(99);
    }

    function test_executeSplitChange_revertsOnDoubleExecute() public {
        vm.prank(OWNER);
        uint256 id = router.requestSplitChange(3000, 7000);
        vm.warp(block.timestamp + SPLIT_TIMELOCK);
        vm.prank(OWNER);
        router.executeSplitChange(id);

        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(FeeRouter.FeeRouter_AlreadyExecuted.selector, id));
        router.executeSplitChange(id);
    }

    function test_cancelSplitChange_succeeds() public {
        vm.prank(OWNER);
        uint256 id = router.requestSplitChange(3000, 7000);

        vm.expectEmit(true, false, false, false, address(router));
        emit FeeRouter.SplitChangeCancelled(id);
        vm.prank(OWNER);
        router.cancelSplitChange(id);

        // Cannot execute later.
        vm.warp(block.timestamp + SPLIT_TIMELOCK);
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(FeeRouter.FeeRouter_AlreadyCancelled.selector, id));
        router.executeSplitChange(id);
    }

    function test_cancelSplitChange_revertsAfterExecute() public {
        vm.prank(OWNER);
        uint256 id = router.requestSplitChange(3000, 7000);
        vm.warp(block.timestamp + SPLIT_TIMELOCK);
        vm.prank(OWNER);
        router.executeSplitChange(id);

        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(FeeRouter.FeeRouter_AlreadyExecuted.selector, id));
        router.cancelSplitChange(id);
    }

    function test_cancelSplitChange_revertsOnDoubleCancel() public {
        vm.prank(OWNER);
        uint256 id = router.requestSplitChange(3000, 7000);
        vm.prank(OWNER);
        router.cancelSplitChange(id);

        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(FeeRouter.FeeRouter_AlreadyCancelled.selector, id));
        router.cancelSplitChange(id);
    }

    function test_cancelSplitChange_revertsForNonOwner() public {
        vm.prank(OWNER);
        uint256 id = router.requestSplitChange(3000, 7000);
        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, ATTACKER)
        );
        router.cancelSplitChange(id);
    }

    /* -------------------------------------------------------------------- */
    /*                        END-TO-END SCENARIO                           */
    /* -------------------------------------------------------------------- */

    function test_e2e_multipleFeesAccumulate() public {
        // 5 routings of 1000 ETX each.
        for (uint256 i = 0; i < 5; i++) {
            _seedRouter(uint128(1000 * ONE));
            vm.prank(VAULT);
            router.routeFee(uint128(1000 * ONE));
        }

        assertEq(fund.balance(), 1000 * ONE);
        assertEq(etx.balanceOf(HARVESTER), 4000 * ONE);
        assertEq(etx.balanceOf(address(router)), 0);
    }
}
