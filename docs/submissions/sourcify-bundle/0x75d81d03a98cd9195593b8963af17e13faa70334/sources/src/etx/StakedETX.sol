// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {
    ERC4626,
    IERC20,
    IERC20Metadata
} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title StakedETX (stETX) — liquid staking token for ETX
/// @notice ERC-4626 share-bearing vault. Deposit ETX, mint stETX shares.
///         Rewards are injected by calling {distributeRewards}, which transfers
///         ETX into the vault. Shares are unchanged, so `totalAssets` grows and
///         the {pricePerShare} exchange rate monotonically increases — every
///         existing stETX holder earns a pro-rata slice of the injected ETX.
///
///         stETX itself is a plain ERC-20 with EIP-2612 permit, so it is
///         composable: it can be listed on our own AMM (ETX/stETX pool),
///         used as collateral for a future lending market, transferred freely,
///         etc. There is no lockup or withdrawal delay — the owner can redeem
///         stETX for ETX at the current exchange rate at any time.
///
///         Price mechanics:
///           - Exchange rate is monotonically non-decreasing. The only outflows
///             are `withdraw` and `redeem`, both of which burn shares pro-rata
///             and leave the exchange rate unchanged.
///           - No slashing, no negative rebases. Worst case is stagnant
///             (no rewards arrive) — the exchange rate holds, it does not drop.
///
///         Inflation-attack mitigation: OZ v5 ERC4626 uses virtual shares /
///         assets with the default offset (0). We additionally enforce a
///         {MIN_DEPOSIT} of 1 ETX on every deposit/mint path to rule out
///         1-wei share games.
contract StakedETX is ERC4626, ERC20Permit {
    using SafeERC20 for IERC20;

    /// @notice Minimum ETX required per deposit or mint. Forecloses dust-value
    ///         share-inflation attacks on a fresh vault. 1 ETX is negligible
    ///         for any real staker.
    uint256 public constant MIN_DEPOSIT = 1e18;

    /// @notice Emitted whenever a caller injects ETX into the vault as rewards.
    ///         Front-ends and indexers should treat this as the canonical
    ///         "rewards realized" signal; plain `transfer` of the underlying
    ///         into the vault also increases `totalAssets` but will not emit
    ///         this event and should be treated as undifferentiated donations.
    event RewardsDistributed(address indexed from, uint256 amount);

    error DepositTooSmall(uint256 provided, uint256 minimum);
    error ZeroAmount();

    constructor(IERC20 asset_)
        ERC4626(asset_)
        ERC20("Staked ETX", "stETX")
        ERC20Permit("Staked ETX")
    {}

    /// @notice Inject `amount` of the underlying asset (ETX) into the vault as
    ///         rewards. The caller must first approve this contract for
    ///         `amount`. Shares are not minted; the exchange rate ticks up.
    ///         Anyone may call this — rewards only benefit existing holders,
    ///         so there is no griefing vector.
    function distributeRewards(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);
        emit RewardsDistributed(msg.sender, amount);
    }

    /// @notice Underlying ETX redeemable per 1e18 stETX. Mirrors
    ///         `convertToAssets(1e18)` for UI/indexer convenience.
    function pricePerShare() external view returns (uint256) {
        return convertToAssets(1e18);
    }

    // -------------------------------------------------------------------------
    // Overrides
    // -------------------------------------------------------------------------

    /// @dev Enforce {MIN_DEPOSIT} on direct deposits.
    function deposit(uint256 assets, address receiver) public override returns (uint256) {
        if (assets < MIN_DEPOSIT) revert DepositTooSmall(assets, MIN_DEPOSIT);
        return super.deposit(assets, receiver);
    }

    /// @dev Enforce {MIN_DEPOSIT} on mint (which pulls variable assets).
    function mint(uint256 shares, address receiver) public override returns (uint256) {
        uint256 assets = previewMint(shares);
        if (assets < MIN_DEPOSIT) revert DepositTooSmall(assets, MIN_DEPOSIT);
        return super.mint(shares, receiver);
    }

    /// @dev Resolve diamond inheritance: ERC4626 and ERC20 both declare
    ///      `decimals()`. ERC4626's implementation adds the decimals offset
    ///      used for inflation-attack mitigation, so that is the correct
    ///      one to expose.
    function decimals() public view virtual override(ERC4626, ERC20) returns (uint8) {
        return ERC4626.decimals();
    }
}
