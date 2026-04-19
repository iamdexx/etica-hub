// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {VestingWallet} from "@openzeppelin/contracts/finance/VestingWallet.sol";
import {VestingWalletCliff} from "@openzeppelin/contracts/finance/VestingWalletCliff.sol";

/// @title EticaHub vesting wallet
/// @notice Concrete VestingWalletCliff used for the treasury (20M ETX) and
///         team (10M ETX) allocations. Linear vest over `duration`, starting
///         at `start`, with no release before `start + cliff`.
/// @dev 4-year linear vest + 6-month cliff recommended. The beneficiary
///      becomes the `owner` via the parent `Ownable(beneficiary)` call.
contract EticaHubVesting is VestingWalletCliff {
    constructor(
        address beneficiary,
        uint64 startTimestamp,
        uint64 durationSeconds,
        uint64 cliffSeconds
    )
        VestingWallet(beneficiary, startTimestamp, durationSeconds)
        VestingWalletCliff(cliffSeconds)
    {}
}
