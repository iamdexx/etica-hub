// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {WarpFlatLinearFee} from "../../src/bridge/WarpFlatLinearFee.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract WarpFlatLinearFeeTest is Test {
    uint256 internal constant USDC = 1e6;
    // 50 bps capped at 50 USDC => maxLinearFee 50 USDC, halfAmount 5,000 USDC.
    uint256 internal constant MAX_LINEAR = 50 * USDC;
    uint256 internal constant HALF = 5_000 * USDC;
    uint256 internal constant FLAT = 2 * USDC;

    MockUSDC internal usdc;
    WarpFlatLinearFee internal fee;
    address internal keeper = address(0xCAFE);

    function setUp() public {
        usdc = new MockUSDC();
        fee = new WarpFlatLinearFee(address(usdc), FLAT, MAX_LINEAR, HALF, keeper);
    }

    function test_quote_is_flat_plus_fifty_bps_capped() public view {
        assertEq(fee.quoteFee(0), FLAT, "dust pays the flat floor");
        assertEq(fee.quoteFee(1), FLAT, "1 unit still pays the flat floor");
        assertEq(fee.quoteFee(100 * USDC), FLAT + 0.5e6, "$100 -> $0.50 + flat");
        assertEq(fee.quoteFee(1_000 * USDC), FLAT + 5 * USDC, "$1k -> $5 + flat");
        assertEq(fee.quoteFee(5_000 * USDC), FLAT + 25 * USDC, "halfAmount -> half of cap");
        assertEq(fee.quoteFee(10_000 * USDC), FLAT + 50 * USDC, "2*halfAmount hits cap");
        assertEq(fee.quoteFee(1_000_000 * USDC), FLAT + 50 * USDC, "cap holds for whales");
    }

    function test_quote_matches_hyperlane_linear_when_flat_is_zero() public {
        WarpFlatLinearFee linear = new WarpFlatLinearFee(address(usdc), 0, MAX_LINEAR, HALF, keeper);
        // Same formula as @hyperlane-xyz/core LinearFee: amount * maxFee / (2 * halfAmount), capped.
        assertEq(linear.quoteFee(3_333 * USDC), (3_333 * USDC * MAX_LINEAR) / (2 * HALF));
        assertEq(linear.quoteFee(1), 0);
    }

    function testFuzz_fee_is_bounded_and_monotonic(uint256 a, uint256 b) public view {
        a = bound(a, 0, 1e30);
        b = bound(b, a, 1e30);
        uint256 fa = fee.quoteFee(a);
        uint256 fb = fee.quoteFee(b);
        assertGe(fa, FLAT);
        assertLe(fa, FLAT + MAX_LINEAR);
        assertLe(fa, fb, "fee never decreases with amount");
    }

    function test_quoteTransferRemote_returns_single_quote_in_token() public view {
        WarpFlatLinearFee.Quote[] memory q = fee.quoteTransferRemote(1, bytes32(0), 250 * USDC);
        assertEq(q.length, 1);
        assertEq(q[0].token, address(usdc));
        assertEq(q[0].amount, FLAT + 1.25e6);
    }

    function test_claim_only_owner_and_only_moves_fee_balance() public {
        usdc.mint(address(fee), 123 * USDC);

        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(0xBAD)));
        fee.claim(address(0xBAD));

        vm.prank(keeper);
        vm.expectRevert(WarpFlatLinearFee.ZeroAddress.selector);
        fee.claim(address(0));

        vm.prank(keeper);
        fee.claim(keeper);
        assertEq(usdc.balanceOf(keeper), 123 * USDC);
        assertEq(usdc.balanceOf(address(fee)), 0);
    }

    function test_constructor_rejects_degenerate_params() public {
        vm.expectRevert(WarpFlatLinearFee.ZeroAddress.selector);
        new WarpFlatLinearFee(address(0), FLAT, MAX_LINEAR, HALF, keeper);
        vm.expectRevert(WarpFlatLinearFee.ZeroHalfAmount.selector);
        new WarpFlatLinearFee(address(usdc), FLAT, MAX_LINEAR, 0, keeper);
        vm.expectRevert(WarpFlatLinearFee.NoFee.selector);
        new WarpFlatLinearFee(address(usdc), 0, 0, HALF, keeper);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new WarpFlatLinearFee(address(usdc), FLAT, MAX_LINEAR, HALF, address(0));
    }
}
