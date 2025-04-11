// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IPool} from "@aave/core-v3/contracts/interfaces/IPool.sol";
import {IPoolAddressesProvider} from "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract FlashLoanArbitrage is Ownable { // Renamed contract for clarity
    using SafeERC20 for IERC20;

    IPool public immutable POOL;
    IPoolAddressesProvider public immutable ADDRESSES_PROVIDER;

    // Token addresses
    address public constant DAI = 0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1;
    address public constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;

    // Accumulated profit in DAI
    uint256 private profitBalanceDAI;

    // Events for logging and debugging.
    event FlashLoanInitiated(
        address indexed initiator,
        address indexed asset,
        uint256 amount,
        bytes params,
        uint256 timestamp
    );
    event FlashLoanReceived(address indexed asset, uint256 amount);
    event SwapExecuted(
        address indexed fromToken,
        address indexed toToken,
        uint256 amountIn,
        uint256 amountOut,
        uint256 timestamp
    );
    event SwapFailed(string message, bytes returnData, uint256 timestamp);
    event SlippageValidation(
        uint256 minAcceptable,
        uint256 received,
        uint256 timestamp
    );
    event ProfitGenerated(uint256 profit);
    event ProfitUpdated(uint256 oldBalance, uint256 newBalance, uint256 timestamp);
    event PreRepayment(
        uint256 repayAmount,
        uint256 currentBalance,
        uint256 amountToApprove,
        uint256 timestamp
    );
    event PostRepayment(uint256 repayAmount, uint256 remainingBalance, uint256 timestamp);
    event PreApproval(
        address token,
        address spender,
        uint256 currentAllowance,
        uint256 amount,
        uint256 timestamp
    );
    event PostApproval(address token, address spender, uint256 newAllowance, uint256 timestamp);
    event ApprovalEnsured(address token, address spender, uint256 amount);
    event SwapCallData(address router, bytes data);
    event DecodedParams(address router1, bytes swapData1, address router2, bytes swapData2, uint256 minAcceptableDAI, uint256 minAcceptableWETHRepay);
    event RouterCallResult(bool success, bytes resultData);
    event RepaymentAmounts(uint256 repayAmountWETH, uint256 swapAmountDAItoWETH);

    // New events to log token balances.
    event LogDaiBalance(uint256 balance, uint256 timestamp);
    event LogWethBalance(uint256 balance, uint256 timestamp);

    /**
     * @notice Constructor.
     * @param _addressesProvider The Aave PoolAddressesProvider address.
     */
    constructor(address _addressesProvider) Ownable(msg.sender) {
        ADDRESSES_PROVIDER = IPoolAddressesProvider(_addressesProvider);
        POOL = IPool(ADDRESSES_PROVIDER.getPool());
    }

    /**
     * @notice Initiates a flash loan in WETH and performs dual swaps: WETH to DAI, then DAI to WETH for repayment.
     * @param amount The flash loan amount (in WETH).
     * @param params Encoded parameters for both swaps:
     *  (address router1, bytes swapData1, address router2, bytes swapData2, uint256 minAcceptableDAI, uint256 minAcceptableWETHRepay)
     *
     * The JS script encodes these as:
     *  ethers.AbiCoder.defaultAbiCoder().encode(
     *      ["address", "bytes", "address", "bytes", "uint256", "uint256"],
     *      [router1, swapData1, router2, swapData2, minAcceptableDAI, minAcceptableWETHRepay]
     *  );
     */
    function executeFlashLoanWithDualSwap(
        uint256 amount,
        bytes calldata params
    ) external onlyOwner {
        require(amount > 0, "Flash loan amount must be > 0");
        emit FlashLoanInitiated(msg.sender, WETH, amount, params, block.timestamp);

        // Initiate flash loan in WETH.
        POOL.flashLoanSimple(
            address(this),
            WETH,
            amount,
            params,
            0
        );
    }

    /**
     * @notice Aave flash loan callback.
     * @dev This function is called by the Aave Pool. It executes both swaps and repays the loan.
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address, /* initiator */
        bytes calldata params
    ) external returns (bool) {
        require(msg.sender == address(POOL), "Unauthorized caller");
        require(asset == WETH, "Flash loan asset must be WETH");

        emit FlashLoanReceived(asset, amount);
        return executeFlashLoanWithDualSwapInternal(amount, premium, params);
    }

    /**
     * @notice Internal function to perform dual swaps: WETH to DAI and DAI to WETH for repayment.
     * @param amount The flash loan amount (in WETH).
     * @param premium The flash loan fee.
     * @param params Encoded parameters: (address router1, bytes swapData1, address router2, bytes swapData2, uint256 minAcceptableDAI, uint256 minAcceptableWETHRepay)
     */
    function executeFlashLoanWithDualSwapInternal(
        uint256 amount,
        uint256 premium,
        bytes calldata params
    ) internal returns (bool) {
        // Decode parameters from your JS script for both swaps and slippage limits.
        (
            address router1,
            bytes memory swapData1,
            address router2,
            bytes memory swapData2,
            uint256 minAcceptableDAI,
            uint256 minAcceptableWETHRepay
        ) = abi.decode(
            params,
            (address, bytes, address, bytes, uint256, uint256)
        );

        // --- Swap 1: WETH to DAI (Maximize DAI) ---
        uint256 swapAmountWETHtoDAI = amount; // Use the entire flash loan amount for the first swap
        ensureApproval(WETH, router1, swapAmountWETHtoDAI); // Approve router1 for WETH

        uint256 preDAIBalance = IERC20(DAI).balanceOf(address(this)); // Record DAI balance before swap

        (bool swap1Success, bytes memory swap1Result) = router1.call(swapData1); // Execute WETH to DAI swap
        if (!swap1Success) {
            string memory reason = _getRevertMsg(swap1Result);
            emit SwapFailed(reason, swap1Result, block.timestamp);
            revert(reason);
        }

        uint256 postDAIBalance = IERC20(DAI).balanceOf(address(this)); // Record DAI balance after swap
        uint256 daiReceived = postDAIBalance - preDAIBalance;
        emit SlippageValidation(minAcceptableDAI, daiReceived, block.timestamp);
        require(daiReceived >= minAcceptableDAI, "WETH to DAI Swap slippage exceeded");
        emit SwapExecuted(WETH, DAI, swapAmountWETHtoDAI, daiReceived, block.timestamp);

        // --- Swap 2: DAI to WETH (Prepare for Repayment) ---
        uint256 repayAmountWETH = amount + premium; // Calculate repayment amount in WETH
        uint256 swapAmountDAItoWETH = daiReceived; // Use all DAI received for swap
        ensureApproval(DAI, router2, swapAmountDAItoWETH); // Approve router2 for DAI

        uint256 preWETHBalancePostSwap1 = IERC20(WETH).balanceOf(address(this)); // WETH balance before DAI to WETH swap

        // Calculate the minimum acceptable WETH needed for repayment.
        emit SwapCallData(router2, swapData2);
        (bool swap2Success, bytes memory swap2Result) = router2.call(swapData2); // Execute DAI to WETH swap
        if (!swap2Success) {
            string memory reason = _getRevertMsg(swap2Result);
            emit SwapFailed(reason, swap2Result, block.timestamp);
            revert(reason);
        }

        uint256 postWETHBalancePostSwap2 = IERC20(WETH).balanceOf(address(this)); // WETH balance after DAI to WETH swap
        uint256 wethRepaid = postWETHBalancePostSwap2 - preWETHBalancePostSwap1;

        emit SlippageValidation(minAcceptableWETHRepay, wethRepaid, block.timestamp);
        require(wethRepaid >= minAcceptableWETHRepay, "DAI to WETH Swap slippage exceeded");
        emit SwapExecuted(DAI, WETH, swapAmountDAItoWETH, wethRepaid, block.timestamp);

        // --- Repayment ---
        uint256 currentWETH = IERC20(WETH).balanceOf(address(this));
        require(currentWETH >= repayAmountWETH, "Insufficient WETH for repayment after swap");

        emit PreRepayment(repayAmountWETH, currentWETH, repayAmountWETH, block.timestamp);
        IERC20(WETH).approve(address(POOL), repayAmountWETH);
        IERC20(WETH).transfer(address(POOL), repayAmountWETH); // Directly transfer WETH for repayment
        emit PostRepayment(repayAmountWETH, currentWETH - repayAmountWETH, block.timestamp);

        // --- Profit Calculation and Update ---
        uint256 oldProfit = profitBalanceDAI;
        profitBalanceDAI += daiReceived; // Profit measured in DAI (gross profit before considering swap costs)
        emit ProfitGenerated(daiReceived);
        emit ProfitUpdated(oldProfit, profitBalanceDAI, block.timestamp);

        return true;
    }

    /**
     * @notice Internal helper to ensure a spender is approved to spend a given token amount.
     */
    function ensureApproval(
        address token,
        address spender,
        uint256 amount
    ) internal {
        emit PreApproval(token, spender, IERC20(token).allowance(address(this), spender), amount, block.timestamp);

        if (IERC20(token).allowance(address(this), spender) < amount) {
            IERC20(token).approve(spender, type(uint256).max);
            emit ApprovalEnsured(token, spender, type(uint256).max);
        }

        // Additionally, ensure approval for a common token transfer proxy if needed.
        address tokenTransferProxy = 0x216B4B4Ba9F3e719726886d34a177484278Bfcae; // Keep this as it might be needed for certain routers
        if (IERC20(token).allowance(address(this), tokenTransferProxy) < amount) {
            IERC20(token).approve(tokenTransferProxy, type(uint256).max);
            emit ApprovalEnsured(token, tokenTransferProxy, type(uint256).max);
        }
        emit PostApproval(token, spender, IERC20(token).allowance(address(this), spender), block.timestamp);
    }

    /**
     * @notice Decodes revert messages from failed low-level calls.
     */
    function _getRevertMsg(bytes memory _returnData) internal pure returns (string memory) {
        // If _returnData length is less than 68, then the transaction reverted silently.
        if (_returnData.length < 68) return "Transaction reverted silently";
        assembly {
            // Skip the function selector.
            _returnData := add(_returnData, 0x04)
        }
        return abi.decode(_returnData, (string));
    }

    /**
     * @notice Returns the accumulated profit in DAI.
     */
    function profitBalanceDAIView() external view returns (uint256) {
        return profitBalanceDAI;
    }

    /**
     * @notice Allows the owner to rescue any tokens mistakenly sent to the contract.
     */
    function rescueTokens(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(owner(), balance);
    }

    /**
     * @notice Logs the current DAI balance of the contract.
     */
    function logDaiBalance() external onlyOwner {
        uint256 balance = IERC20(DAI).balanceOf(address(this));
        emit LogDaiBalance(balance, block.timestamp);
    }

    /**
     * @notice Logs the current WETH balance of the contract.
     */
    function logWethBalance() external onlyOwner {
        uint256 balance = IERC20(WETH).balanceOf(address(this));
        emit LogWethBalance(balance, block.timestamp);
    }

    // Allow the contract to receive ETH.
    receive() external payable {
        payable(owner()).transfer(msg.value);
    }
}
