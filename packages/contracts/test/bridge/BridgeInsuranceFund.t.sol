// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {BridgeInsuranceFund} from "../../src/bridge/BridgeInsuranceFund.sol";
import {ETXToken} from "../../src/etx/ETXToken.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract BridgeInsuranceFundTest is Test {
    ETXToken internal etx;
    BridgeInsuranceFund internal fund;

    address internal constant OWNER = address(0x0117E2);
    address internal constant TREASURY = address(0x77E45);
    address internal constant VAULT = address(0xA17_BEEF);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant ATTACKER = address(0xBAD);

    uint64 internal constant TIMELOCK = 30 days;
    uint256 internal constant ONE = 1e18;

    function setUp() public {
        etx = new ETXToken(TREASURY);
        fund = new BridgeInsuranceFund(IERC20(address(etx)), OWNER, TIMELOCK);

        // Pre-fund the insurance pool with 10M ETX from treasury.
        vm.startPrank(TREASURY);
        etx.approve(address(fund), type(uint256).max);
        vm.stopPrank();

        // Wire vault.
        vm.prank(OWNER);
        fund.setBridgeVault(VAULT);
    }

    function _seed(uint128 amount) internal {
        vm.prank(TREASURY);
        fund.deposit(amount);
    }

    /* -------------------------------------------------------------------- */
    /*                            CONSTRUCTOR                               */
    /* -------------------------------------------------------------------- */

    function test_constructor_setsImmutables() public view {
        assertEq(address(fund.etx()), address(etx));
        assertEq(fund.owner(), OWNER);
        assertEq(fund.withdrawTimelock(), TIMELOCK);
    }

    function test_constructor_revertsOnZeroEtx() public {
        vm.expectRevert(BridgeInsuranceFund.InsuranceFund_ZeroAddress.selector);
        new BridgeInsuranceFund(IERC20(address(0)), OWNER, TIMELOCK);
    }

    function test_constructor_revertsOnZeroOwner() public {
        // Ownable rejects zero owner first via OwnableInvalidOwner.
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new BridgeInsuranceFund(IERC20(address(etx)), address(0), TIMELOCK);
    }

    /* -------------------------------------------------------------------- */
    /*                          BRIDGE-VAULT WIRE                           */
    /* -------------------------------------------------------------------- */

    function test_setBridgeVault_revertsIfAlreadySet() public {
        vm.prank(OWNER);
        vm.expectRevert(BridgeInsuranceFund.InsuranceFund_VaultAlreadySet.selector);
        fund.setBridgeVault(address(0xDEAD));
    }

    function test_setBridgeVault_revertsOnZero() public {
        // Deploy fresh fund without wired vault.
        BridgeInsuranceFund fresh = new BridgeInsuranceFund(IERC20(address(etx)), OWNER, TIMELOCK);
        vm.prank(OWNER);
        vm.expectRevert(BridgeInsuranceFund.InsuranceFund_ZeroAddress.selector);
        fresh.setBridgeVault(address(0));
    }

    function test_setBridgeVault_revertsForNonOwner() public {
        BridgeInsuranceFund fresh = new BridgeInsuranceFund(IERC20(address(etx)), OWNER, TIMELOCK);
        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, ATTACKER)
        );
        fresh.setBridgeVault(VAULT);
    }

    /* -------------------------------------------------------------------- */
    /*                              DEPOSITS                                */
    /* -------------------------------------------------------------------- */

    function test_deposit_succeeds() public {
        _seed(uint128(10_000_000 * ONE));
        assertEq(fund.balance(), 10_000_000 * ONE);
    }

    function test_deposit_revertsOnZero() public {
        vm.prank(TREASURY);
        vm.expectRevert(BridgeInsuranceFund.InsuranceFund_ZeroAmount.selector);
        fund.deposit(0);
    }

    function test_deposit_emitsEvent() public {
        vm.expectEmit(true, false, false, true, address(fund));
        emit BridgeInsuranceFund.InsuranceDeposited(TREASURY, uint128(1000 * ONE));
        vm.prank(TREASURY);
        fund.deposit(uint128(1000 * ONE));
    }

    /* -------------------------------------------------------------------- */
    /*                                DRAW                                  */
    /* -------------------------------------------------------------------- */

    function test_draw_succeedsForVault() public {
        _seed(uint128(10_000_000 * ONE));
        vm.prank(VAULT);
        uint128 drawn = fund.draw(uint128(50_000 * ONE));
        assertEq(drawn, 50_000 * ONE);
        assertEq(etx.balanceOf(VAULT), 50_000 * ONE);
        assertEq(fund.balance(), (10_000_000 - 50_000) * ONE);
    }

    function test_draw_revertsForNonVault() public {
        _seed(uint128(1000 * ONE));
        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(
                BridgeInsuranceFund.InsuranceFund_OnlyBridgeVault.selector, ATTACKER
            )
        );
        fund.draw(uint128(1));
    }

    function test_draw_revertsForOwner() public {
        // Owner is NOT the vault. Owner must use timelocked withdraw flow.
        _seed(uint128(1000 * ONE));
        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(
                BridgeInsuranceFund.InsuranceFund_OnlyBridgeVault.selector, OWNER
            )
        );
        fund.draw(uint128(1));
    }

    function test_draw_partialOnInsufficientBalance() public {
        _seed(uint128(100 * ONE));
        vm.prank(VAULT);
        uint128 drawn = fund.draw(uint128(500 * ONE));
        assertEq(drawn, 100 * ONE);
        assertEq(fund.balance(), 0);
        assertEq(etx.balanceOf(VAULT), 100 * ONE);
    }

    function test_draw_zeroOnEmptyFund() public {
        vm.prank(VAULT);
        uint128 drawn = fund.draw(uint128(500 * ONE));
        assertEq(drawn, 0);
        assertEq(etx.balanceOf(VAULT), 0);
    }

    function test_draw_zeroAmountReturnsZero() public {
        _seed(uint128(1000 * ONE));
        vm.prank(VAULT);
        uint128 drawn = fund.draw(0);
        assertEq(drawn, 0);
        assertEq(fund.balance(), 1000 * ONE);
    }

    function test_draw_emitsEvent() public {
        _seed(uint128(1000 * ONE));
        vm.expectEmit(true, false, false, true, address(fund));
        emit BridgeInsuranceFund.InsuranceDrawn(VAULT, uint128(400 * ONE), uint128(400 * ONE));
        vm.prank(VAULT);
        fund.draw(uint128(400 * ONE));
    }

    function testFuzz_draw_neverExceedsBalance(uint128 seed, uint128 request) public {
        seed = uint128(bound(seed, 1, 50_000_000 * ONE));
        _seed(seed);
        vm.prank(VAULT);
        uint128 drawn = fund.draw(request);
        assertLe(drawn, request);
        assertLe(drawn, seed);
    }

    /* -------------------------------------------------------------------- */
    /*                       OWNER WITHDRAWAL FLOW                          */
    /* -------------------------------------------------------------------- */

    function test_requestWithdrawal_storesAndEmits() public {
        _seed(uint128(10_000_000 * ONE));

        vm.prank(OWNER);
        vm.expectEmit(true, true, false, true, address(fund));
        emit BridgeInsuranceFund.WithdrawalRequested(
            0, BOB, uint128(1000 * ONE), uint64(block.timestamp) + TIMELOCK
        );
        uint256 id = fund.requestWithdrawal(uint128(1000 * ONE), BOB);
        assertEq(id, 0);
        assertEq(fund.nextWithdrawalId(), 1);
    }

    function test_requestWithdrawal_revertsForNonOwner() public {
        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, ATTACKER)
        );
        fund.requestWithdrawal(uint128(1), BOB);
    }

    function test_requestWithdrawal_revertsOnZeroAmount() public {
        vm.prank(OWNER);
        vm.expectRevert(BridgeInsuranceFund.InsuranceFund_ZeroAmount.selector);
        fund.requestWithdrawal(0, BOB);
    }

    function test_requestWithdrawal_revertsOnZeroRecipient() public {
        vm.prank(OWNER);
        vm.expectRevert(BridgeInsuranceFund.InsuranceFund_ZeroAddress.selector);
        fund.requestWithdrawal(uint128(1), address(0));
    }

    function test_executeWithdrawal_succeedsAfterTimelock() public {
        _seed(uint128(10_000_000 * ONE));

        vm.prank(OWNER);
        uint256 id = fund.requestWithdrawal(uint128(1000 * ONE), BOB);

        vm.warp(block.timestamp + TIMELOCK);

        vm.prank(OWNER);
        fund.executeWithdrawal(id);

        assertEq(etx.balanceOf(BOB), 1000 * ONE);
        assertEq(fund.balance(), (10_000_000 - 1000) * ONE);
    }

    function test_executeWithdrawal_revertsBeforeTimelock() public {
        _seed(uint128(10_000_000 * ONE));

        vm.prank(OWNER);
        uint256 id = fund.requestWithdrawal(uint128(1000 * ONE), BOB);

        // Just before the deadline.
        vm.warp(block.timestamp + TIMELOCK - 1);
        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(
                BridgeInsuranceFund.InsuranceFund_TimelockNotElapsed.selector,
                uint64(block.timestamp + 1),
                uint64(block.timestamp)
            )
        );
        fund.executeWithdrawal(id);
    }

    function test_executeWithdrawal_revertsOnInvalidId() public {
        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(
                BridgeInsuranceFund.InsuranceFund_InvalidWithdrawalId.selector, 99
            )
        );
        fund.executeWithdrawal(99);
    }

    function test_executeWithdrawal_revertsOnDoubleExecute() public {
        _seed(uint128(10_000_000 * ONE));

        vm.prank(OWNER);
        uint256 id = fund.requestWithdrawal(uint128(1000 * ONE), BOB);
        vm.warp(block.timestamp + TIMELOCK);
        vm.prank(OWNER);
        fund.executeWithdrawal(id);

        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(BridgeInsuranceFund.InsuranceFund_AlreadyExecuted.selector, id)
        );
        fund.executeWithdrawal(id);
    }

    function test_cancelWithdrawal_succeeds() public {
        _seed(uint128(10_000_000 * ONE));

        vm.prank(OWNER);
        uint256 id = fund.requestWithdrawal(uint128(1000 * ONE), BOB);

        vm.expectEmit(true, false, false, false, address(fund));
        emit BridgeInsuranceFund.WithdrawalCancelled(id);
        vm.prank(OWNER);
        fund.cancelWithdrawal(id);

        // Cannot execute now.
        vm.warp(block.timestamp + TIMELOCK);
        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(BridgeInsuranceFund.InsuranceFund_AlreadyCancelled.selector, id)
        );
        fund.executeWithdrawal(id);
    }

    function test_cancelWithdrawal_revertsOnDoubleCancel() public {
        _seed(uint128(10_000_000 * ONE));
        vm.prank(OWNER);
        uint256 id = fund.requestWithdrawal(uint128(1000 * ONE), BOB);

        vm.prank(OWNER);
        fund.cancelWithdrawal(id);

        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(BridgeInsuranceFund.InsuranceFund_AlreadyCancelled.selector, id)
        );
        fund.cancelWithdrawal(id);
    }

    function test_cancelWithdrawal_revertsAfterExecute() public {
        _seed(uint128(10_000_000 * ONE));
        vm.prank(OWNER);
        uint256 id = fund.requestWithdrawal(uint128(1000 * ONE), BOB);
        vm.warp(block.timestamp + TIMELOCK);
        vm.prank(OWNER);
        fund.executeWithdrawal(id);

        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(BridgeInsuranceFund.InsuranceFund_AlreadyExecuted.selector, id)
        );
        fund.cancelWithdrawal(id);
    }

    function test_cancelWithdrawal_revertsForNonOwner() public {
        vm.prank(OWNER);
        uint256 id = fund.requestWithdrawal(uint128(1), BOB);

        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, ATTACKER)
        );
        fund.cancelWithdrawal(id);
    }

    /* -------------------------------------------------------------------- */
    /*                          OWNERSHIP TRANSFER                          */
    /* -------------------------------------------------------------------- */

    function test_ownership_isTwoStep() public {
        // Owner1 → owner2 transfer requires two-step accept (Ownable2Step).
        address newOwner = address(0xBEEF);

        vm.prank(OWNER);
        fund.transferOwnership(newOwner);
        // Transfer is pending, owner unchanged.
        assertEq(fund.owner(), OWNER);
        assertEq(fund.pendingOwner(), newOwner);

        vm.prank(newOwner);
        fund.acceptOwnership();
        assertEq(fund.owner(), newOwner);
        assertEq(fund.pendingOwner(), address(0));
    }

    /* -------------------------------------------------------------------- */
    /*                       END-TO-END SCENARIO                            */
    /* -------------------------------------------------------------------- */

    function test_e2e_drawAfterShortfall() public {
        // 10M pre-fund, vault drains a partial shortfall, owner withdraws remainder.
        _seed(uint128(10_000_000 * ONE));

        vm.prank(VAULT);
        uint128 drawn = fund.draw(uint128(500_000 * ONE));
        assertEq(drawn, 500_000 * ONE);
        assertEq(fund.balance(), 9_500_000 * ONE);

        // Owner schedules a 1M withdrawal.
        vm.prank(OWNER);
        uint256 id = fund.requestWithdrawal(uint128(1_000_000 * ONE), ALICE);

        vm.warp(block.timestamp + TIMELOCK);

        vm.prank(OWNER);
        fund.executeWithdrawal(id);

        assertEq(etx.balanceOf(VAULT), 500_000 * ONE);
        assertEq(etx.balanceOf(ALICE), 1_000_000 * ONE);
        assertEq(fund.balance(), 8_500_000 * ONE);
    }
}
