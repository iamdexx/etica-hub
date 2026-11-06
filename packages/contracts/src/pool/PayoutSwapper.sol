// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IWEGAZ {
    function deposit() external payable;
}

interface IV2Router {
    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory);
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory);
}

interface IV2Pair {
    function token0() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
}

/// @title PayoutSwapper
/// @notice Turns a native EGAZ mining payout into USDC.e for the miner, in one transaction.
/// The pool's payout wallet calls `payInUsdc{value: egaz}(miner, minOut)`. The EGAZ is wrapped, swapped on
/// the standalone V2 USDC.e/EGAZ pair and the USDC.e is sent straight to the miner. If the swap would take
/// more than `maxImpactBps` of the pool's EGAZ reserve, or return less than `minOut`, the call reverts and the
/// pool falls back to a plain EGAZ payout. No funds are ever held here between calls.
contract PayoutSwapper is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IWEGAZ public immutable wegaz;
    IERC20 public immutable usdc;
    IV2Router public immutable router;
    IV2Pair public immutable pair;

    /// @notice Largest share of the pair's EGAZ reserve one payout may take, in bps (100 = 1%).
    uint16 public maxImpactBps = 100;
    mapping(address => bool) public payers;

    event PaidInUsdc(address indexed payer, address indexed miner, uint256 egazIn, uint256 usdcOut);
    event PayerSet(address indexed payer, bool allowed);
    event MaxImpactSet(uint16 bps);

    error NotPayer();
    error ZeroAmount();
    error ZeroAddress();
    error ImpactTooHigh(uint256 impactBps, uint16 maxBps);
    error BpsOutOfRange();

    constructor(address wegaz_, address usdc_, address router_, address pair_, address owner_)
        Ownable(owner_)
    {
        if (
            wegaz_ == address(0) || usdc_ == address(0) || router_ == address(0)
                || pair_ == address(0)
        ) {
            revert ZeroAddress();
        }
        wegaz = IWEGAZ(wegaz_);
        usdc = IERC20(usdc_);
        router = IV2Router(router_);
        pair = IV2Pair(pair_);
    }

    function setPayer(address payer, bool allowed) external onlyOwner {
        payers[payer] = allowed;
        emit PayerSet(payer, allowed);
    }

    function setMaxImpactBps(uint16 bps) external onlyOwner {
        if (bps == 0 || bps > 5000) revert BpsOutOfRange();
        maxImpactBps = bps;
        emit MaxImpactSet(bps);
    }

    /// @notice Expected USDC.e for `egazIn`, and the share of the EGAZ reserve it would take (bps).
    function quote(uint256 egazIn) public view returns (uint256 usdcOut, uint256 impactBps) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        uint256 reserveIn = pair.token0() == address(wegaz) ? r0 : r1;
        uint256[] memory amounts = router.getAmountsOut(egazIn, _path());
        usdcOut = amounts[1];
        impactBps = (egazIn * 10_000) / (reserveIn + egazIn);
    }

    /// @notice Wrap the sent EGAZ, swap it to USDC.e and deliver the USDC.e to `miner`.
    /// @param minOut Minimum USDC.e the miner must receive; the payer computes it from `quote` minus its slippage.
    function payInUsdc(address miner, uint256 minOut)
        external
        payable
        nonReentrant
        returns (uint256 usdcOut)
    {
        if (!payers[msg.sender]) revert NotPayer();
        if (msg.value == 0) revert ZeroAmount();
        if (miner == address(0)) revert ZeroAddress();

        (, uint256 impactBps) = quote(msg.value);
        if (impactBps > maxImpactBps) revert ImpactTooHigh(impactBps, maxImpactBps);

        wegaz.deposit{value: msg.value}();
        IERC20(address(wegaz)).forceApprove(address(router), msg.value);
        uint256[] memory amounts =
            router.swapExactTokensForTokens(msg.value, minOut, _path(), miner, block.timestamp);
        usdcOut = amounts[1];
        emit PaidInUsdc(msg.sender, miner, msg.value, usdcOut);
    }

    /// @notice Recover anything sent here by mistake (the contract never holds funds by design).
    function rescue(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            require(ok, "rescue: send failed");
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    function _path() private view returns (address[] memory path) {
        path = new address[](2);
        path[0] = address(wegaz);
        path[1] = address(usdc);
    }
}
