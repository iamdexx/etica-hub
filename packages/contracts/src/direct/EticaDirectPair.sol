// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

import {EticaDirectERC20} from "./EticaDirectERC20.sol";
import {IEticaDirectFactory} from "./IEticaDirectFactory.sol";
import {Math} from "../swap/libraries/Math.sol";
import {UQ112x112} from "../swap/libraries/UQ112x112.sol";
import {IERC20Minimal} from "../swap/interfaces/IERC20Minimal.sol";
import {IEticaSwapFactory} from "../swap/interfaces/IEticaSwapFactory.sol";
import {IEticaSwapCallee} from "../swap/interfaces/IEticaSwapCallee.sol";

/// @title EticaSwap Direct pair (stETX-gated constant product)
/// @notice Constant-product AMM pair (x*y=k), 1.00% swap fee, identical to
///         {EticaSwapPair} except that every `to` recipient of mint, burn and
///         swap must pass {IEticaDirectFactory.isAllowed}: hold the stETX
///         threshold, or be one of the venue's own pairs / whitelisted routers.
/// @dev Port of UniswapV2Pair to Solidity 0.8.x. Invariants and math are
///      equivalent to the audited V2 contract.
contract EticaDirectPair is EticaDirectERC20 {
    using UQ112x112 for uint224;

    uint256 public constant MINIMUM_LIQUIDITY = 10 ** 3;
    bytes4 private constant SELECTOR_TRANSFER =
        bytes4(keccak256(bytes("transfer(address,uint256)")));

    address public factory;
    address public token0;
    address public token1;

    uint112 private reserve0;
    uint112 private reserve1;
    uint32 private blockTimestampLast;

    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;
    // reserve0 * reserve1 immediately after the most recent liquidity event
    uint256 public kLast;

    uint256 private unlocked = 1;

    modifier lock() {
        require(unlocked == 1, "ESwap: LOCKED");
        unlocked = 0;
        _;
        unlocked = 1;
    }

    event Mint(address indexed sender, uint256 amount0, uint256 amount1);
    event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to);
    event Swap(
        address indexed sender,
        uint256 amount0In,
        uint256 amount1In,
        uint256 amount0Out,
        uint256 amount1Out,
        address indexed to
    );
    event Sync(uint112 reserve0, uint112 reserve1);

    constructor() {
        factory = msg.sender;
    }

    /// @notice Called once by the factory at deploy time.
    function initialize(address _token0, address _token1) external {
        require(msg.sender == factory, "ESwap: FORBIDDEN");
        token0 = _token0;
        token1 = _token1;
    }

    function getReserves()
        public
        view
        returns (uint112 _reserve0, uint112 _reserve1, uint32 _blockTimestampLast)
    {
        _reserve0 = reserve0;
        _reserve1 = reserve1;
        _blockTimestampLast = blockTimestampLast;
    }

    function _safeTransfer(address token, address to, uint256 value) private {
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(SELECTOR_TRANSFER, to, value));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "ESwap: TRANSFER_FAILED");
    }

    function _update(uint256 balance0, uint256 balance1, uint112 _reserve0, uint112 _reserve1)
        private
    {
        require(balance0 <= type(uint112).max && balance1 <= type(uint112).max, "ESwap: OVERFLOW");
        uint32 blockTimestamp = uint32(block.timestamp % 2 ** 32);
        unchecked {
            uint32 timeElapsed = blockTimestamp - blockTimestampLast;
            if (timeElapsed > 0 && _reserve0 != 0 && _reserve1 != 0) {
                price0CumulativeLast += uint256(UQ112x112.encode(_reserve1).uqdiv(_reserve0))
                * timeElapsed;
                price1CumulativeLast += uint256(UQ112x112.encode(_reserve0).uqdiv(_reserve1))
                * timeElapsed;
            }
        }
        reserve0 = uint112(balance0);
        reserve1 = uint112(balance1);
        blockTimestampLast = blockTimestamp;
        emit Sync(reserve0, reserve1);
    }

    /// @dev The venue gate. Venue contracts (sibling pairs, whitelisted
    ///      routers / harvester) are only valid recipients when a whitelisted
    ///      contract is the caller, so a non-staker can neither park output on
    ///      a sibling pair and `skim` it nor dump it into the router. Everyone
    ///      else must pass the stETX check.
    function _requireAllowed(address to) private view {
        IEticaDirectFactory fac = IEticaDirectFactory(factory);
        if (fac.isPair(to) || fac.whitelist(to)) {
            require(fac.whitelist(msg.sender), "EDirect: NOT_STAKER");
            return;
        }
        require(fac.isAllowed(to), "EDirect: NOT_STAKER");
    }

    /// @dev Mints fee equivalent to 1/6 of the growth in sqrt(k) to `feeTo`.
    function _mintFee(uint112 _reserve0, uint112 _reserve1) private returns (bool feeOn) {
        address feeTo = IEticaSwapFactory(factory).feeTo();
        feeOn = feeTo != address(0);
        uint256 _kLast = kLast;
        if (feeOn) {
            if (_kLast != 0) {
                uint256 rootK = Math.sqrt(uint256(_reserve0) * _reserve1);
                uint256 rootKLast = Math.sqrt(_kLast);
                if (rootK > rootKLast) {
                    uint256 numerator = totalSupply * (rootK - rootKLast);
                    uint256 denominator = rootK * 5 + rootKLast;
                    uint256 liquidity = numerator / denominator;
                    if (liquidity > 0) _mint(feeTo, liquidity);
                }
            }
        } else if (_kLast != 0) {
            kLast = 0;
        }
    }

    /// @notice Mints LP tokens for the caller based on amounts transferred in beforehand.
    function mint(address to) external lock returns (uint256 liquidity) {
        _requireAllowed(to);
        (uint112 _reserve0, uint112 _reserve1,) = getReserves();
        uint256 balance0 = IERC20Minimal(token0).balanceOf(address(this));
        uint256 balance1 = IERC20Minimal(token1).balanceOf(address(this));
        uint256 amount0 = balance0 - _reserve0;
        uint256 amount1 = balance1 - _reserve1;

        bool feeOn = _mintFee(_reserve0, _reserve1);
        uint256 _totalSupply = totalSupply;
        if (_totalSupply == 0) {
            liquidity = Math.sqrt(amount0 * amount1) - MINIMUM_LIQUIDITY;
            _mint(address(0), MINIMUM_LIQUIDITY);
        } else {
            liquidity = Math.min(
                (amount0 * _totalSupply) / _reserve0, (amount1 * _totalSupply) / _reserve1
            );
        }
        require(liquidity > 0, "ESwap: INSUFFICIENT_LIQUIDITY_MINTED");
        _mint(to, liquidity);

        _update(balance0, balance1, _reserve0, _reserve1);
        if (feeOn) kLast = uint256(reserve0) * reserve1;
        emit Mint(msg.sender, amount0, amount1);
    }

    /// @notice Burns LP tokens from this contract and sends the underlyings to `to`.
    function burn(address to) external lock returns (uint256 amount0, uint256 amount1) {
        _requireAllowed(to);
        (uint112 _reserve0, uint112 _reserve1,) = getReserves();
        address _token0 = token0;
        address _token1 = token1;
        uint256 balance0 = IERC20Minimal(_token0).balanceOf(address(this));
        uint256 balance1 = IERC20Minimal(_token1).balanceOf(address(this));
        uint256 liquidity = balanceOf[address(this)];

        bool feeOn = _mintFee(_reserve0, _reserve1);
        uint256 _totalSupply = totalSupply;
        amount0 = (liquidity * balance0) / _totalSupply;
        amount1 = (liquidity * balance1) / _totalSupply;
        require(amount0 > 0 && amount1 > 0, "ESwap: INSUFFICIENT_LIQUIDITY_BURNED");
        _burn(address(this), liquidity);
        _safeTransfer(_token0, to, amount0);
        _safeTransfer(_token1, to, amount1);
        balance0 = IERC20Minimal(_token0).balanceOf(address(this));
        balance1 = IERC20Minimal(_token1).balanceOf(address(this));

        _update(balance0, balance1, _reserve0, _reserve1);
        if (feeOn) kLast = uint256(reserve0) * reserve1;
        emit Burn(msg.sender, amount0, amount1, to);
    }

    /// @notice Swap: the caller must have pre-paid `amount{0,1}In` (constant-product check).
    ///         Supports flash swaps via the `data` callback to `IEticaSwapCallee.eticaSwapCall`.
    /// @notice Swap with the fee tier of the recipient `to` (direct callers).
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data)
        external
        lock
    {
        _requireAllowed(to);
        _swap(amount0Out, amount1Out, to, IEticaDirectFactory(factory).feeBpsFor(to), data);
    }

    /// @notice Swap on behalf of `trader`, whose stETX balance sets the fee.
    ///         Only whitelisted routers may name a trader, so the recipient of
    ///         an EGAZ unwrap or an intermediate hop still pays the fee of the
    ///         wallet that initiated the trade.
    function swapFor(
        uint256 amount0Out,
        uint256 amount1Out,
        address to,
        address trader,
        bytes calldata data
    ) external lock {
        IEticaDirectFactory fac = IEticaDirectFactory(factory);
        require(fac.whitelist(msg.sender), "EDirect: NOT_ROUTER");
        require(fac.isAllowed(trader), "EDirect: NOT_STAKER");
        _requireAllowed(to);
        _swap(amount0Out, amount1Out, to, fac.feeBpsFor(trader), data);
    }

    struct SwapVars {
        uint112 reserve0;
        uint112 reserve1;
        uint256 balance0;
        uint256 balance1;
        uint256 amount0In;
        uint256 amount1In;
        uint256 feeBps;
    }

    /// @dev Constant-product check with the tiered fee on the input, in basis
    ///      points (10_000 = 100%).
    function _requireK(SwapVars memory v) private pure {
        uint256 balance0Adjusted = v.balance0 * 10_000 - v.amount0In * v.feeBps;
        uint256 balance1Adjusted = v.balance1 * 10_000 - v.amount1In * v.feeBps;
        require(
            balance0Adjusted * balance1Adjusted >= uint256(v.reserve0) * v.reserve1 * (10_000 ** 2),
            "ESwap: K"
        );
    }

    function _swap(
        uint256 amount0Out,
        uint256 amount1Out,
        address to,
        uint256 feeBps,
        bytes calldata data
    ) private {
        require(amount0Out > 0 || amount1Out > 0, "ESwap: INSUFFICIENT_OUTPUT_AMOUNT");
        SwapVars memory v;
        v.feeBps = feeBps;
        (v.reserve0, v.reserve1,) = getReserves();
        require(amount0Out < v.reserve0 && amount1Out < v.reserve1, "ESwap: INSUFFICIENT_LIQUIDITY");

        {
            address _token0 = token0;
            address _token1 = token1;
            require(to != _token0 && to != _token1, "ESwap: INVALID_TO");
            if (amount0Out > 0) _safeTransfer(_token0, to, amount0Out);
            if (amount1Out > 0) _safeTransfer(_token1, to, amount1Out);
            if (data.length > 0) {
                IEticaSwapCallee(to).eticaSwapCall(msg.sender, amount0Out, amount1Out, data);
            }
            v.balance0 = IERC20Minimal(_token0).balanceOf(address(this));
            v.balance1 = IERC20Minimal(_token1).balanceOf(address(this));
        }
        v.amount0In =
            v.balance0 > v.reserve0 - amount0Out ? v.balance0 - (v.reserve0 - amount0Out) : 0;
        v.amount1In =
            v.balance1 > v.reserve1 - amount1Out ? v.balance1 - (v.reserve1 - amount1Out) : 0;
        require(v.amount0In > 0 || v.amount1In > 0, "ESwap: INSUFFICIENT_INPUT_AMOUNT");
        _requireK(v);

        _update(v.balance0, v.balance1, v.reserve0, v.reserve1);
        emit Swap(msg.sender, v.amount0In, v.amount1In, amount0Out, amount1Out, to);
    }

    /// @notice Force balances to match reserves (sends excess to `to`).
    function skim(address to) external lock {
        _requireAllowed(to);
        address _token0 = token0;
        address _token1 = token1;
        _safeTransfer(_token0, to, IERC20Minimal(_token0).balanceOf(address(this)) - reserve0);
        _safeTransfer(_token1, to, IERC20Minimal(_token1).balanceOf(address(this)) - reserve1);
    }

    /// @notice Force reserves to match balances.
    function sync() external lock {
        _update(
            IERC20Minimal(token0).balanceOf(address(this)),
            IERC20Minimal(token1).balanceOf(address(this)),
            reserve0,
            reserve1
        );
    }
}
