// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @title wRES local E2E test doubles
///
/// @notice These mocks exist ONLY to stand up a fully local two-chain loop for
///         the wRES keeper. They are deliberately permissive (open mint) and
///         carry no security — never deploy them anywhere but a throwaway local
///         anvil / private TRON node.

/// @dev Stand-in for `EticaResearchNFT`: an ERC-721 the locker mints + approves
///      before calling `RESLockVault.lock`. Open mint by design.
contract MockRESNFT is ERC721 {
    constructor() ERC721("Mock RES NFT", "mRES") {}

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }
}

/// @dev Stand-in for ETX, the payout destination token. The DEX router holds a
///      large ETX float and pays it out 1:1 on swaps. Open mint by design.
contract MockETX is ERC20 {
    constructor() ERC20("Mock ETX", "mETX") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Minimal Uniswap-v2-style router that swaps eTRX -> ETX at a fixed 1:1
///      rate. Matches the exact `getAmountsOut` / `swapExactTokensForTokens`
///      signatures the keeper's `routerAbi` calls. It must be pre-funded with
///      the output token (ETX) so it can pay swaps out.
contract MockDexRouter {
    /// @notice 1:1 quote across the whole path (each hop preserves the amount).
    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        pure
        returns (uint256[] memory amounts)
    {
        amounts = new uint256[](path.length);
        for (uint256 i = 0; i < path.length; i++) {
            amounts[i] = amountIn;
        }
    }

    /// @notice Pull `amountIn` of path[0] from the caller, send an equal amount
    ///         of path[last] to `to`. Reverts on expiry or if it would fall
    ///         below `amountOutMin` (it never does at 1:1, but the floor is
    ///         honoured so the keeper's slippage guard is genuinely exercised).
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts) {
        require(deadline >= block.timestamp, "router: expired");
        require(path.length >= 2, "router: bad path");
        uint256 amountOut = amountIn; // fixed 1:1
        require(amountOut >= amountOutMin, "router: insufficient output");

        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
        require(IERC20(path[path.length - 1]).transfer(to, amountOut), "router: transfer failed");

        amounts = new uint256[](path.length);
        for (uint256 i = 0; i < path.length; i++) {
            amounts[i] = amountIn;
        }
    }
}

/// @dev TRON-side stand-in for the CoreReactor "freeze-forever" sink. The real
///      reactor calls FreezeBalanceV2; here we only need to (a) be a contract
///      (the miner's constructor requires `code.length > 0`) and (b) accept the
///      TRX that `WrappedRESMiner._freezeForever` forwards. The TRX stays here
///      forever — there is intentionally no withdraw path.
contract MockCoreReactor {
    uint256 public totalFrozen;

    event Frozen(uint256 amount, uint256 totalFrozen);

    receive() external payable {
        totalFrozen += msg.value;
        emit Frozen(msg.value, totalFrozen);
    }
}
