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

    constructor(address _addressesProvider) Ownable(msg.sender) {
        ADDRESSES_PROVIDER = IPoolAddressesProvider(_addressesProvider);
        POOL = IPool(ADDRESSES_PROVIDER.getPool());
    }

    function executeFlashLoanWithDualSwap(
        uint256 amount,
        bytes calldata params
    ) external onlyOwner {
        require(amount > 0, "Flash loan amount must be > 0");
        emit FlashLoanInitiated(msg.sender, WETH, amount, params, block.timestamp);
        POOL.flashLoanSimple(
            address(this),
            WETH,
            amount,
            params,
            0
        );
    }

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

    function profitBalanceDAIView() external view returns (uint256) {
        return profitBalanceDAI;
    }

    receive() external payable {
        payable(owner()).transfer(msg.value);
    }

    function rescueTokens(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(owner(), balance);
    }
}
