// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {StakedETX} from "../../src/etx/StakedETX.sol";
import {ETXToken} from "../../src/etx/ETXToken.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract StakedETXTest is Test {
    ETXToken internal etx;
    StakedETX internal vault;

    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant CAROL = address(0xCA8014);
    address internal constant KEEPER = address(0xDEAD_BEEF);
    address internal constant TREASURY = address(0x7);

    uint256 internal constant ONE = 1e18;

    function setUp() public {
        etx = new ETXToken(TREASURY);
        vault = new StakedETX(IERC20(address(etx)));

        vm.startPrank(TREASURY);
        etx.transfer(ALICE, 10_000_000 * ONE);
        etx.transfer(BOB, 10_000_000 * ONE);
        etx.transfer(CAROL, 10_000_000 * ONE);
        etx.transfer(KEEPER, 1_000_000 * ONE);
        vm.stopPrank();

        _approve(ALICE);
        _approve(BOB);
        _approve(CAROL);
        _approve(KEEPER);
    }

    function _approve(address who) internal {
        vm.prank(who);
        etx.approve(address(vault), type(uint256).max);
    }

    // -------------------------------------------------------------------------
    // Metadata / shape
    // -------------------------------------------------------------------------

    function test_metadata_nameSymbolDecimals() public view {
        assertEq(vault.name(), "Staked ETX");
        assertEq(vault.symbol(), "stETX");
        assertEq(vault.decimals(), 18);
        assertEq(vault.asset(), address(etx));
    }

    function test_initial_pricePerShareIsOne() public view {
        // With totalSupply=0 OZ ERC4626 returns 1e18 via virtual shares.
        assertEq(vault.pricePerShare(), ONE);
    }

    function test_MIN_DEPOSIT_isOneEther() public view {
        assertEq(vault.MIN_DEPOSIT(), ONE);
    }

    // -------------------------------------------------------------------------
    // Deposit / mint guards
    // -------------------------------------------------------------------------

    function test_deposit_rejectsBelowMin() public {
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(StakedETX.DepositTooSmall.selector, ONE - 1, ONE));
        vault.deposit(ONE - 1, ALICE);
    }

    function test_deposit_acceptsExactlyMin() public {
        vm.prank(ALICE);
        uint256 shares = vault.deposit(ONE, ALICE);
        assertEq(shares, ONE);
        assertEq(vault.balanceOf(ALICE), ONE);
        assertEq(etx.balanceOf(address(vault)), ONE);
    }

    function test_deposit_rejectsZero() public {
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(StakedETX.DepositTooSmall.selector, 0, ONE));
        vault.deposit(0, ALICE);
    }

    function test_mint_rejectsBelowMinAssets() public {
        // previewMint(1) is (close to) 1 wei of asset on fresh vault → rejects.
        vm.prank(ALICE);
        vm.expectRevert();
        vault.mint(1, ALICE);
    }

    // -------------------------------------------------------------------------
    // Reward injection — exchange rate must strictly increase
    // -------------------------------------------------------------------------

    function test_distributeRewards_growsPricePerShare() public {
        vm.prank(ALICE);
        vault.deposit(100 * ONE, ALICE);

        uint256 rateBefore = vault.pricePerShare();

        vm.prank(KEEPER);
        vault.distributeRewards(10 * ONE);

        uint256 rateAfter = vault.pricePerShare();
        assertGt(rateAfter, rateBefore, "rate must increase after rewards");
        // Expected ~1.1x growth on 100 stETX backed by 110 ETX.
        assertApproxEqRel(rateAfter, (ONE * 11) / 10, 1e15); // 0.1% tolerance
    }

    function test_distributeRewards_emitsEvent() public {
        vm.prank(ALICE);
        vault.deposit(100 * ONE, ALICE);

        vm.expectEmit(true, true, true, true, address(vault));
        emit StakedETX.RewardsDistributed(KEEPER, 7 * ONE);
        vm.prank(KEEPER);
        vault.distributeRewards(7 * ONE);
    }

    function test_distributeRewards_rejectsZero() public {
        vm.prank(KEEPER);
        vm.expectRevert(StakedETX.ZeroAmount.selector);
        vault.distributeRewards(0);
    }

    function test_distributeRewards_anyoneCanCall() public {
        vm.prank(ALICE);
        vault.deposit(100 * ONE, ALICE);

        // BOB (not keeper) can still donate rewards — no grief risk.
        vm.prank(BOB);
        vault.distributeRewards(5 * ONE);
        assertEq(etx.balanceOf(address(vault)), 105 * ONE);
    }

    // -------------------------------------------------------------------------
    // Fair multi-depositor distribution
    // -------------------------------------------------------------------------

    function test_secondDepositor_getsFewerSharesAfterRewards() public {
        vm.prank(ALICE);
        uint256 aliceShares = vault.deposit(100 * ONE, ALICE);

        // Keeper injects rewards → rate climbs to ~2 ETX / stETX.
        vm.prank(KEEPER);
        vault.distributeRewards(100 * ONE);

        vm.prank(BOB);
        uint256 bobShares = vault.deposit(100 * ONE, BOB);

        // Alice deposited 100 ETX pre-rewards, got 100 shares.
        // Bob deposited 100 ETX post-rewards (rate=2), so got ~50 shares.
        assertEq(aliceShares, 100 * ONE);
        assertApproxEqRel(bobShares, 50 * ONE, 1e15);
    }

    function test_withdraw_returnsProRataIncludingRewards() public {
        vm.prank(ALICE);
        vault.deposit(100 * ONE, ALICE);
        vm.prank(BOB);
        vault.deposit(100 * ONE, BOB);

        // 20 ETX rewards distributed equally across 200 shares → 10 each.
        vm.prank(KEEPER);
        vault.distributeRewards(20 * ONE);

        uint256 aliceBalBefore = etx.balanceOf(ALICE);
        uint256 aliceShares = vault.balanceOf(ALICE);
        vm.prank(ALICE);
        vault.redeem(aliceShares, ALICE, ALICE);
        uint256 aliceReceived = etx.balanceOf(ALICE) - aliceBalBefore;

        // Alice should recover ~110 ETX (principal + half of 20 rewards).
        assertApproxEqRel(aliceReceived, 110 * ONE, 1e15);
    }

    function test_rewardsWithoutDepositors_areSafelyHeld() public {
        // No depositor → rewards stay inside the vault as dust-bonus for the
        // first depositor. Must not revert, must not block future deposits.
        vm.prank(KEEPER);
        vault.distributeRewards(5 * ONE);

        vm.prank(ALICE);
        uint256 shares = vault.deposit(100 * ONE, ALICE);

        // Alice absorbs the 5 ETX bonus — fewer shares per ETX on entry,
        // redeems for more. Not a theft, she still profits.
        assertLt(shares, 100 * ONE);
        vm.prank(ALICE);
        vault.redeem(shares, ALICE, ALICE);
    }

    // -------------------------------------------------------------------------
    // The critical invariant: pricePerShare is monotonically non-decreasing
    // -------------------------------------------------------------------------

    function test_invariant_pricePerShare_neverDecreases() public {
        // Seed with a few depositors.
        vm.prank(ALICE);
        vault.deposit(100 * ONE, ALICE);
        vm.prank(BOB);
        vault.deposit(100 * ONE, BOB);
        vm.prank(CAROL);
        vault.deposit(100 * ONE, CAROL);

        uint256 lastRate = vault.pricePerShare();

        // Interleave 50 randomized operations: deposit / redeem / rewards.
        uint256 seed = 0xC0FFEE;
        for (uint256 i = 0; i < 50; i++) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 op = seed % 3;
            uint256 mag = ((seed >> 8) % 10 + 1) * ONE; // 1..10 ETX
            address actor = [ALICE, BOB, CAROL][((seed >> 16) % 3)];

            if (op == 0) {
                // deposit
                vm.prank(actor);
                vault.deposit(mag, actor);
            } else if (op == 1) {
                // redeem a slice of the actor's shares (if any)
                uint256 bal = vault.balanceOf(actor);
                if (bal > 0) {
                    uint256 toBurn = bal / 10;
                    if (toBurn > 0) {
                        vm.prank(actor);
                        vault.redeem(toBurn, actor, actor);
                    }
                }
            } else {
                // distribute rewards
                vm.prank(KEEPER);
                vault.distributeRewards(mag);
            }

            uint256 nowRate = vault.pricePerShare();
            assertGe(nowRate, lastRate, "pricePerShare MUST NOT decrease");
            lastRate = nowRate;
        }
    }

    function testFuzz_depositWithdraw_preservesRate(uint96 amountA, uint96 amountB) public {
        amountA = uint96(bound(amountA, ONE, 1_000_000 * ONE));
        amountB = uint96(bound(amountB, ONE, 1_000_000 * ONE));

        vm.prank(ALICE);
        vault.deposit(amountA, ALICE);

        uint256 rateBefore = vault.pricePerShare();

        vm.prank(BOB);
        vault.deposit(amountB, BOB);

        uint256 bobShares = vault.balanceOf(BOB);
        vm.prank(BOB);
        vault.redeem(bobShares, BOB, BOB);

        // After a round-trip deposit/redeem with no rewards in between, the
        // rate must be unchanged (modulo the virtual-offset rounding noise —
        // a few wei). It must NEVER decrease below the starting rate.
        uint256 rateAfter = vault.pricePerShare();
        assertGe(rateAfter, rateBefore, "redeem must not decrease rate");
    }

    // -------------------------------------------------------------------------
    // Inflation-attack mitigation
    // -------------------------------------------------------------------------

    function test_inflationAttack_isBlockedByMinDeposit() public {
        // Classic ERC4626 inflation attack: attacker deposits 1 wei, then
        // donates a large amount of assets to skew convertToShares() against
        // the next depositor. Our MIN_DEPOSIT = 1 ETX blocks the 1-wei step.
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(StakedETX.DepositTooSmall.selector, 1, ONE));
        vault.deposit(1, ALICE);
    }

    // -------------------------------------------------------------------------
    // Permit — stETX is EIP-2612 so it can be approved gaslessly
    // -------------------------------------------------------------------------

    function test_permit_signsAndSetsAllowance() public {
        uint256 pk = 0xA11CE_DEF;
        address signer = vm.addr(pk);
        // Give signer some stETX
        vm.prank(TREASURY);
        etx.transfer(signer, 100 * ONE);
        vm.prank(signer);
        etx.approve(address(vault), type(uint256).max);
        vm.prank(signer);
        vault.deposit(100 * ONE, signer);

        bytes32 domainSep = vault.DOMAIN_SEPARATOR();
        uint256 deadline = block.timestamp + 1 hours;
        uint256 value = 42 * ONE;
        uint256 nonce = vault.nonces(signer);
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                signer,
                BOB,
                value,
                nonce,
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);

        vault.permit(signer, BOB, value, deadline, v, r, s);
        assertEq(vault.allowance(signer, BOB), value);
    }
}
