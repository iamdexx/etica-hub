// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

import {EticaDirectERC20} from "./EticaDirectERC20.sol";
import {IEticaDirectFactory} from "./IEticaDirectFactory.sol";
import {Math} from "../swap/libraries/Math.sol";
import {UQ112x112} from "../swap/libraries/UQ112x112.sol";
import {IERC20Minimal} from "../swap/interfaces/IERC20Minimal.sol";
import {IEticaSwapFactory} from "../swap/interfaces/IEticaSwapFactory.sol";
import {IEticaSwapPair} from "../swap/interfaces/IEticaSwapPair.sol";
import {IWEGAZ} from "../swap/interfaces/IWEGAZ.sol";
import {TransferHelper} from "../swap/libraries/TransferHelper.sol";

interface IHubRouterMeta {
    function factory() external view returns (address);
    function WEGAZ_TOKEN() external view returns (address);
    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity);
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts);
}

/// @title EticaSwap Direct metapair (a window over the ETX hub)
/// @notice A V2-shaped pair for `token0`/`token1` that owns no raw reserves of
///         either. Its liquidity is LP of the two hub pools `token0`/ETX and
///         `token1`/ETX, so every coin deposited here deepens the hub, and the
///         reserves it reports are its real, on-chain-provable share of those
///         pools expressed in `token0` and `token1` (each pool's ETX half
///         valued at that pool's spot price). The reported ratio is therefore
///         the hub cross price by construction, and every swap settles on the
///         hub (`tokenIn` → ETX → `tokenOut`) at execution time, never against
///         the reported reserves. Indexers see standard PairCreated / Mint /
///         Swap / Sync events; traders must pass the stETX gate and pay their
///         stETX tier fee, which is forwarded in kind to the factory `feeTo`.
/// @dev    Airtight by construction: the hub LP it holds can never leave
///         (`burn` always reverts, there is no transfer path for it and no
///         owner), swap output is only ever what the hub returned for the
///         trader's own input, and the reported reserves are never an input to
///         any settlement, so manipulating them yields nothing. Shares are
///         minted for accounting / events only and are not redeemable.
contract EticaDirectMetaPair is EticaDirectERC20 {
    using UQ112x112 for uint224;

    uint256 public constant MINIMUM_LIQUIDITY = 10 ** 3;

    address public immutable factory;
    address public token0;
    address public token1;
    address public hubRouter;
    address public hubFactory;
    address public etx;
    address public wegaz;
    /// @notice Hub pools this window draws on: `token0`/ETX and `token1`/ETX.
    address public hubPair0;
    address public hubPair1;

    uint112 private reserve0;
    uint112 private reserve1;
    uint32 private blockTimestampLast;
    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;

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
    event FeeForwarded(address indexed token, address indexed to, uint256 amount);

    constructor(address _factory) {
        factory = _factory;
    }

    /// @notice Called once by the factory at deploy time.
    function initialize(address _token0, address _token1, address _hubRouter) external {
        require(msg.sender == factory, "ESwap: FORBIDDEN");
        require(hubRouter == address(0), "EDirect: INITIALIZED");
        token0 = _token0;
        token1 = _token1;
        hubRouter = _hubRouter;
        hubFactory = IHubRouterMeta(_hubRouter).factory();
        wegaz = IHubRouterMeta(_hubRouter).WEGAZ_TOKEN();
        etx = IEticaSwapFactory(hubFactory).etx();
        require(_token0 != etx && _token1 != etx, "EDirect: ETX_IS_HUB");
        hubPair0 = IEticaSwapFactory(hubFactory).getPair(_token0, etx);
        hubPair1 = IEticaSwapFactory(hubFactory).getPair(_token1, etx);
        require(hubPair0 != address(0) && hubPair1 != address(0), "EDirect: NO_HUB_PAIR");
    }

    // ------------------------------------------------------------------ RESERVES

    /// @notice Our share of a hub pool, as (token, ETX) amounts.
    function _hubShare(address pair, address token)
        private
        view
        returns (uint256 tokenAmt, uint256 etxAmt)
    {
        IEticaSwapPair p = IEticaSwapPair(pair);
        uint256 lp = p.balanceOf(address(this));
        uint256 supply = p.totalSupply();
        if (lp == 0 || supply == 0) return (0, 0);
        (uint112 r0, uint112 r1,) = p.getReserves();
        (uint256 rToken, uint256 rEtx) = p.token0() == token ? (r0, r1) : (r1, r0);
        tokenAmt = (uint256(rToken) * lp) / supply;
        etxAmt = (uint256(rEtx) * lp) / supply;
    }

    /// @notice Live reserves. The window is worth `2*(e0+e1)` ETX (each hub
    ///         LP position is half token, half ETX, and the halves are equal
    ///         at spot). Half of that value is reported in `token0` at the
    ///         `token0`/ETX pool's spot price and half in `token1` at the
    ///         `token1`/ETX pool's, so `r1/r0` is exactly the hub cross price
    ///         and `r0 + r1` (in USD terms) is the window's real TVL.
    function liveReserves() public view returns (uint256 r0, uint256 r1) {
        (, uint256 e0) = _hubShare(hubPair0, token0);
        (, uint256 e1) = _hubShare(hubPair1, token1);
        uint256 etxValue = e0 + e1;
        if (etxValue == 0) return (0, 0);
        (uint112 p0r0, uint112 p0r1,) = IEticaSwapPair(hubPair0).getReserves();
        (uint256 p0Token, uint256 p0Etx) =
            IEticaSwapPair(hubPair0).token0() == token0 ? (p0r0, p0r1) : (p0r1, p0r0);
        (uint112 p1r0, uint112 p1r1,) = IEticaSwapPair(hubPair1).getReserves();
        (uint256 p1Token, uint256 p1Etx) =
            IEticaSwapPair(hubPair1).token0() == token1 ? (p1r0, p1r1) : (p1r1, p1r0);
        r0 = p0Etx == 0 ? 0 : (etxValue * p0Token) / p0Etx;
        r1 = p1Etx == 0 ? 0 : (etxValue * p1Token) / p1Etx;
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

    /// @notice Hub LP this window holds in each hub pool.
    function hubLiquidity() external view returns (uint256 lp0, uint256 lp1) {
        lp0 = IEticaSwapPair(hubPair0).balanceOf(address(this));
        lp1 = IEticaSwapPair(hubPair1).balanceOf(address(this));
    }

    function _update() private {
        (uint256 balance0, uint256 balance1) = liveReserves();
        require(balance0 <= type(uint112).max && balance1 <= type(uint112).max, "ESwap: OVERFLOW");
        uint32 blockTimestamp = uint32(block.timestamp % 2 ** 32);
        uint112 _reserve0 = reserve0;
        uint112 _reserve1 = reserve1;
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

    // ------------------------------------------------------------------ GATE

    /// Deposits are protocol-only: the venue owner or a whitelisted contract
    /// (harvester, seeder). Nobody else can become a (locked) LP here.
    function _requireDepositor() private view {
        IEticaDirectFactory fac = IEticaDirectFactory(factory);
        require(
            msg.sender == fac.feeToSetter() || fac.whitelist(msg.sender), "EDirect: NOT_DEPOSITOR"
        );
    }

    function _requireAllowed(address to) private view {
        IEticaDirectFactory fac = IEticaDirectFactory(factory);
        if (fac.isPair(to) || fac.whitelist(to)) {
            require(fac.whitelist(msg.sender), "EDirect: NOT_STAKER");
            return;
        }
        require(fac.isAllowed(to), "EDirect: NOT_STAKER");
    }

    function _feeSink() private view returns (address sink) {
        sink = IEticaDirectFactory(factory).feeTo();
        if (sink == address(0)) sink = IEticaDirectFactory(factory).feeToSetter();
    }

    // ------------------------------------------------------------------ MINT (deposit into the hub)

    /// @notice Turn whatever `token0`, `token1` and ETX sit on this contract
    ///         into hub LP: half of each token is swapped to ETX, loose ETX is
    ///         split across both legs, then each leg is added to its hub pool.
    ///         Shares go to `to` for accounting only — they are not
    ///         redeemable, this liquidity is locked in the hub for good.
    function mint(address to) external lock returns (uint256 liquidity) {
        _requireDepositor();
        (uint256 before0, uint256 before1) = liveReserves();
        uint256 rootKBefore = Math.sqrt(before0 * before1);

        address _etx = etx;
        uint256 bal0 = IERC20Minimal(token0).balanceOf(address(this));
        uint256 bal1 = IERC20Minimal(token1).balanceOf(address(this));
        uint256 looseEtx = IERC20Minimal(_etx).balanceOf(address(this));
        require(bal0 > 0 || bal1 > 0 || looseEtx > 0, "ESwap: INSUFFICIENT_INPUT_AMOUNT");

        // Loose ETX (e.g. a harvester's POL slice) buys the two tokens half/half
        // so it lands as balanced legs below.
        if (looseEtx > 0) {
            _hubSwap(_etx, token0, looseEtx / 2, 0, address(this));
            _hubSwap(_etx, token1, looseEtx - looseEtx / 2, 0, address(this));
            bal0 = IERC20Minimal(token0).balanceOf(address(this));
            bal1 = IERC20Minimal(token1).balanceOf(address(this));
        }
        _depositLeg(token0, bal0);
        _depositLeg(token1, bal1);

        (uint256 after0, uint256 after1) = liveReserves();
        uint256 rootKAfter = Math.sqrt(after0 * after1);
        uint256 _totalSupply = totalSupply;
        if (_totalSupply == 0) {
            liquidity = rootKAfter - MINIMUM_LIQUIDITY;
            _mint(address(0), MINIMUM_LIQUIDITY);
        } else {
            liquidity = (_totalSupply * (rootKAfter - rootKBefore)) / rootKBefore;
        }
        require(liquidity > 0, "ESwap: INSUFFICIENT_LIQUIDITY_MINTED");
        _mint(to, liquidity);
        _update();
        emit Mint(msg.sender, after0 - before0, after1 - before1);
    }

    /// @dev Half of `amount` → ETX on the hub, then add (rest, ETX) to the
    ///      token's hub pool. Whatever the pool cannot absorb at its ratio
    ///      (hub-fee rounding, ~0.15% of the leg) is donated to that same hub
    ///      pool, so the window never holds raw tokens between transactions.
    function _depositLeg(address token, uint256 amount) private {
        if (amount == 0) return;
        address _etx = etx;
        uint256 half = amount / 2;
        uint256 etxOut = _hubSwap(token, _etx, half, 0, address(this));
        uint256 rest = amount - half;
        address router = hubRouter;
        TransferHelper.safeApprove(token, router, rest);
        TransferHelper.safeApprove(_etx, router, etxOut);
        IHubRouterMeta(router)
            .addLiquidity(token, _etx, rest, etxOut, 0, 0, address(this), block.timestamp);
        TransferHelper.safeApprove(token, router, 0);
        TransferHelper.safeApprove(_etx, router, 0);
        address pair = token == token0 ? hubPair0 : hubPair1;
        bool donated;
        uint256 left = IERC20Minimal(token).balanceOf(address(this));
        if (left > 0) {
            TransferHelper.safeTransfer(token, pair, left);
            donated = true;
        }
        left = IERC20Minimal(_etx).balanceOf(address(this));
        if (left > 0 && token == token1) {
            TransferHelper.safeTransfer(_etx, pair, left);
            donated = true;
        }
        if (donated) IEticaSwapPair(pair).sync();
    }

    function _hubSwap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        address to
    ) private returns (uint256 amountOut) {
        if (amountIn == 0) return 0;
        address router = hubRouter;
        TransferHelper.safeApprove(tokenIn, router, amountIn);
        address[] memory path;
        address _etx = etx;
        if (tokenIn == _etx || tokenOut == _etx) {
            path = new address[](2);
            path[0] = tokenIn;
            path[1] = tokenOut;
        } else {
            path = new address[](3);
            path[0] = tokenIn;
            path[1] = _etx;
            path[2] = tokenOut;
        }
        uint256[] memory amounts = IHubRouterMeta(router)
            .swapExactTokensForTokens(amountIn, minOut, path, to, block.timestamp);
        amountOut = amounts[amounts.length - 1];
    }

    /// @notice Liquidity is locked in the hub for good; there is no way out.
    function burn(address) external pure returns (uint256, uint256) {
        revert("EDirect: LOCKED_LIQUIDITY");
    }

    // ------------------------------------------------------------------ SWAP (settles on the hub)

    /// @notice V2-shaped swap: pre-pay the input token to this contract, ask
    ///         for `amount0Out` xor `amount1Out`. The caller must pass the gate
    ///         and is charged its own tier (never the recipient's); the fee is
    ///         taken from the input and forwarded to `feeTo`; the rest is
    ///         swapped on the hub (`in` → ETX → `out`) with `amountXOut` as the
    ///         min-out, and the full hub output goes to `to`. Flash swaps are
    ///         not supported (`data` must be empty).
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data)
        external
        lock
    {
        IEticaDirectFactory fac = IEticaDirectFactory(factory);
        require(fac.isAllowed(msg.sender), "EDirect: NOT_STAKER");
        _requireAllowed(to);
        require(data.length == 0, "EDirect: NO_FLASH_SWAP");
        require((amount0Out > 0) != (amount1Out > 0), "ESwap: INSUFFICIENT_OUTPUT_AMOUNT");
        _swap(amount0Out > 0, amount0Out + amount1Out, to, fac.feeBpsFor(msg.sender));
    }

    /// @notice Swap priced at `trader`'s stETX tier; whitelisted routers only.
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
        require(data.length == 0, "EDirect: NO_FLASH_SWAP");
        require((amount0Out > 0) != (amount1Out > 0), "ESwap: INSUFFICIENT_OUTPUT_AMOUNT");
        _swap(amount0Out > 0, amount0Out + amount1Out, to, fac.feeBpsFor(trader));
    }

    /// @notice Pull-style convenience for wallets: `msg.sender` pays
    ///         `amountIn` of `tokenIn` (approved beforehand) and is charged its
    ///         own tier; output to `to` must be at least `amountOutMin`.
    function swapExactIn(
        address tokenIn,
        uint256 amountIn,
        uint256 amountOutMin,
        address to,
        uint256 deadline
    ) external lock returns (uint256 amountOut) {
        require(deadline >= block.timestamp, "ESwap: EXPIRED");
        IEticaDirectFactory fac = IEticaDirectFactory(factory);
        require(fac.isAllowed(msg.sender), "EDirect: NOT_STAKER");
        _requireAllowed(to);
        require(tokenIn == token0 || tokenIn == token1, "ESwap: INVALID_PATH");
        TransferHelper.safeTransferFrom(tokenIn, msg.sender, address(this), amountIn);
        amountOut = _swap(tokenIn == token1, amountOutMin, to, fac.feeBpsFor(msg.sender));
    }

    /// @dev `out0` selects the direction (`token1` in → `token0` out when true).
    function _swap(bool out0, uint256 minOut, address to, uint256 feeBps)
        private
        returns (uint256 amountOut)
    {
        address _token0 = token0;
        address _token1 = token1;
        require(to != _token0 && to != _token1 && to != address(this), "ESwap: INVALID_TO");
        (address tokenIn, address tokenOut) = out0 ? (_token1, _token0) : (_token0, _token1);
        uint256 amountIn = IERC20Minimal(tokenIn).balanceOf(address(this));
        require(amountIn > 0, "ESwap: INSUFFICIENT_INPUT_AMOUNT");

        uint256 fee = (amountIn * feeBps) / 10_000;
        if (fee > 0) {
            address sink = _feeSink();
            TransferHelper.safeTransfer(tokenIn, sink, fee);
            emit FeeForwarded(tokenIn, sink, fee);
        }
        amountOut = _hubSwap(tokenIn, tokenOut, amountIn - fee, minOut, to);

        _update();
        if (out0) emit Swap(msg.sender, 0, amountIn, amountOut, 0, to);
        else emit Swap(msg.sender, amountIn, 0, 0, amountOut, to);
    }

    /// @notice What `trader` would receive for `amountIn` of `tokenIn` right now
    ///         (tier fee off the input, then the hub's own quote).
    function quoteOut(address tokenIn, uint256 amountIn, address trader)
        external
        view
        returns (uint256 amountOut)
    {
        require(tokenIn == token0 || tokenIn == token1, "ESwap: INVALID_PATH");
        address tokenOut = tokenIn == token0 ? token1 : token0;
        uint256 fee = (amountIn * IEticaDirectFactory(factory).feeBpsFor(trader)) / 10_000;
        address[] memory path = new address[](3);
        path[0] = tokenIn;
        path[1] = etx;
        path[2] = tokenOut;
        uint256[] memory amounts = IHubRouterMeta(hubRouter).getAmountsOut(amountIn - fee, path);
        amountOut = amounts[2];
    }

    // ------------------------------------------------------------------ HOUSEKEEPING

    /// @notice Loose `token0` / `token1` / ETX (donations, rounding dust) can
    ///         only go to the venue fee sink; the hub LP is untouchable.
    function skim(address to) external lock {
        require(to == _feeSink(), "EDirect: SKIM_TO_FEE_SINK");
        _skimToken(token0, to);
        _skimToken(token1, to);
        _skimToken(etx, to);
    }

    function _skimToken(address token, address to) private {
        uint256 bal = IERC20Minimal(token).balanceOf(address(this));
        if (bal > 0) TransferHelper.safeTransfer(token, to, bal);
    }

    /// @notice Re-read the hub and republish reserves (anyone, e.g. a keeper
    ///         after hub trades, so indexers see a fresh price).
    function sync() external lock {
        _update();
    }
}
