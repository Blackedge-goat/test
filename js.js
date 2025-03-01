const axios = require('axios');
const { ethers } = require('ethers');
const { constructSimpleSDK } = require('@paraswap/sdk');
require('dotenv').config();

// Configuration (adjust contract address to the new DualSwap contract)
const PARASWAP_API_URL = 'https://apiv5.paraswap.io';
const CHAIN_ID = 42161; // Arbitrum
const CONTRACT_ADDRESS = '0x733d90c91c3B5250a49Da9b9A5d866Ef5Ff63057'; // **UPDATE TO THE DEPLOYED DualSwap CONTRACT ADDRESS**
const CHECK_INTERVAL = 5000;
const MIN_PROFIT_THRESHOLD_USD = 4;
const LOAN_AMOUNTS = ['1'];
const SLIPPAGE_PERCENT = 7; // Slippage tolerance as a percentage

// ParaSwap Configuration
const PARASWAP_PARTNERS = {
    referrer: 'arbitrage-bot-dual-swap', // Updated referrer for dual swap strategy
    fee: 0
};

// Token Configuration (same as before)
const ERC20_ABI = [
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)'
];

const TOKENS = {
    DAI: {
        address: '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1',
        decimals: 18,
        abi: ERC20_ABI
    },
    WETH: {
        address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
        decimals: 18,
        abi: ERC20_ABI
    }
};

// Initialize Ethereum components (same as before)
const provider = new ethers.JsonRpcProvider(process.env.TENDERLY_RPC_URL);
const signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const paraSwap = constructSimpleSDK({
    chainId: CHAIN_ID,
    fetcher: axios,
    version: '5',
    apiURL: PARASWAP_API_URL,
    partner: PARASWAP_PARTNERS.referrer
});

// Initialize contracts with ABI for Dual Swap Contract
const arbitrageContract = new ethers.Contract(
    CONTRACT_ADDRESS,
    [
        // Core Function ABI for Dual Swap
        {
            "inputs": [
                {"internalType": "uint256","name": "amount","type": "uint256"},
                {"internalType": "bytes","name": "params","type": "bytes"}
            ],
            "name": "executeFlashLoanWithDualSwap", // **Updated function name**
            "outputs": [],
            "stateMutability": "nonpayable",
            "type": "function"
        },
        // Include other necessary ABI entries from your DualSwap contract ABI
        ...require('./FlashLoanArbitrageABI.json') // **Use ABI for DualSwap Contract**
    ],
    signer
);

const tokenContracts = { // Token contracts initialization (same as before)
    DAI: new ethers.Contract(TOKENS.DAI.address, TOKENS.DAI.abi, signer),
    WETH: new ethers.Contract(TOKENS.WETH.address, TOKENS.WETH.abi, signer)
};

// Enhanced approval system
async function ensureApprovals() {
    try {
        const spender = await getSpender(); // Retrieve ParaSwap spender address
        const arbitrageContractAddress = CONTRACT_ADDRESS; // Arbitrage contract address
        const userAddress = await signer.getAddress(); // User's wallet address

        console.log('Verifying approvals for:');
        console.log('- ParaSwap Spender:', spender);
        console.log('- Arbitrage Contract:', arbitrageContractAddress);

        // Check approvals for both ParaSwap and Arbitrage Contract
        for (const tokenSymbol of ['DAI', 'WETH']) {
            const contract = tokenContracts[tokenSymbol]; // Get ERC20 contract for the token

            // Check ParaSwap allowance
            let allowance = await contract.allowance(userAddress, spender);
            console.log(`${tokenSymbol} allowance for ParaSwap: ${ethers.formatUnits(allowance, 18)}`);
            if (allowance === 0n) {
                console.log(`Approving ${tokenSymbol} for ParaSwap...`);
                const tx = await contract.approve(spender, ethers.MaxUint256); // Approve unlimited tokens
                console.log(`Approval transaction sent for ParaSwap: ${tx.hash}`);
                const receipt = await tx.wait(); // Wait for the transaction to be mined
                console.log(`${tokenSymbol} approved for ParaSwap. Gas used: ${receipt.gasUsed.toString()}`);

                // Verify approval
                const newAllowance = await contract.allowance(userAddress, spender);
                if (newAllowance === 0n) {
                    throw new Error(`Failed to approve ${tokenSymbol} for ParaSwap`);
                }
            }

            // Check Arbitrage Contract allowance
            allowance = await contract.allowance(userAddress, arbitrageContractAddress);
            console.log(`${tokenSymbol} allowance for Arbitrage Contract: ${ethers.formatUnits(allowance, 18)}`);
            if (allowance === 0n) {
                console.log(`Approving ${tokenSymbol} for Arbitrage Contract...`);
                const tx = await contract.approve(arbitrageContractAddress, ethers.MaxUint256); // Approve unlimited tokens
                console.log(`Approval transaction sent for Arbitrage Contract: ${tx.hash}`);
                const receipt = await tx.wait(); // Wait for the transaction to be mined
                console.log(`${tokenSymbol} approved for Arbitrage Contract. Gas used: ${receipt.gasUsed.toString()}`);

                // Verify approval
                const newAllowance = await contract.allowance(userAddress, arbitrageContractAddress);
                if (newAllowance === 0n) {
                    throw new Error(`Failed to approve ${tokenSymbol} for Arbitrage Contract`);
                }
            }
        }

        console.log('All necessary approvals confirmed.');
    } catch (error) {
        console.error('Approval verification failed:', error);
        throw error; // Throw error to be handled by the calling function
    }
}

// Updated getSpender with better error handling
async function getSpender() {
    try {
        // Attempt to fetch the ParaSwap spender address
        const spender = await paraSwap.swap.getSpender();
        if (!ethers.isAddress(spender)) throw new Error('Invalid spender address returned from ParaSwap');
        return spender; // Return the fetched spender address if valid
    } catch (error) {
        console.error('Failed to get ParaSwap spender:', error.message);
        // Fallback to a known proxy address if ParaSwap request fails
        return '0xdef171fe48cf0115b1d80b88dc8eab59176fee57';
    }
}

async function getPriceRoute(srcToken, destToken, returnToken, amountWei) {
    try {
        console.log('Fetching price route for dual swaps with params:', {
            srcToken,
            destToken,
            returnToken, // Added returnToken for DAI -> WETH swap
            amount: amountWei.toString(),
            network: CHAIN_ID
        });

        // --- Route 1: WETH to DAI ---
        const paramsWETHtoDAI = {
            srcToken,
            destToken,
            amount: amountWei.toString(),
            srcDecimals: 18,
            destDecimals: 18,
            network: CHAIN_ID,
            side: 'SELL',
            options: {
                partner: PARASWAP_PARTNERS.referrer,
                includeDEXS: null,
                excludeDEXS: [],
                onlyDEXS: false,
                maxImpact: 50,
            }
        };

        console.log('Fetching WETH to DAI price route...');
        const responseWETHtoDAI = await axios.get(`${PARASWAP_API_URL}/prices`, {
            params: paramsWETHtoDAI,
            validateStatus: false
        });

        if (responseWETHtoDAI.status !== 200 || !responseWETHtoDAI.data?.priceRoute) {
            console.error('Error fetching WETH to DAI price route:', responseWETHtoDAI.status, responseWETHtoDAI.data);
            throw new Error(`ParaSwap API error for WETH to DAI: ${JSON.stringify(responseWETHtoDAI.data)}`);
        }
        const priceRouteWETHtoDAI = responseWETHtoDAI.data.priceRoute;
        console.log('WETH to DAI Price Route Details:', { srcUSD: priceRouteWETHtoDAI.srcUSD, destUSD: priceRouteWETHtoDAI.destUSD });


        // --- Route 2: DAI to WETH (for repayment) ---
        // Calculate the estimated DAI needed for repayment.
        // This is a simplified estimate, you might need to refine based on actual quotes and fees.
        const estimatedDAIToSwapForRepayment = BigInt(priceRouteWETHtoDAI.destAmount); // Assume we use all DAI received initially
        const paramsDAItoWETH = {
            srcToken: destToken, // DAI
            destToken: returnToken, // WETH
            amount: estimatedDAIToSwapForRepayment.toString(),
            srcDecimals: 18,
            destDecimals: 18,
            network: CHAIN_ID,
            side: 'SELL', // Selling DAI to buy WETH
            options: {
                partner: PARASWAP_PARTNERS.referrer,
                includeDEXS: null,
                excludeDEXS: [],
                onlyDEXS: false,
                maxImpact: 50,
            }
        };

        console.log('Fetching DAI to WETH price route for repayment...');
        const responseDAItoWETH = await axios.get(`${PARASWAP_API_URL}/prices`, {
            params: paramsDAItoWETH,
            validateStatus: false
        });

        if (responseDAItoWETH.status !== 200 || !responseDAItoWETH.data?.priceRoute) {
            console.error('Error fetching DAI to WETH price route:', responseDAItoWETH.status, responseDAItoWETH.data);
            throw new Error(`ParaSwap API error for DAI to WETH: ${JSON.stringify(responseDAItoWETH.data)}`);
        }
        const priceRouteDAItoWETH = responseDAItoWETH.data.priceRoute;
        console.log('DAI to WETH Price Route Details:', { srcUSD: priceRouteDAItoWETH.srcUSD, destUSD: priceRouteDAItoWETH.destUSD });


        return { priceRouteWETHtoDAI, priceRouteDAItoWETH }; // Return both price routes

    } catch (error) {
        console.error('Error in getPriceRoute for dual swap:', error);
        throw error;
    }
}

async function calculateNetProfit(priceRoutes, _loanAmount) {
    try {
        const priceRouteWETHtoDAI = priceRoutes.priceRouteWETHtoDAI;
        const priceRouteDAItoWETH = priceRoutes.priceRouteDAItoWETH;

        const grossProfitUSD = parseFloat(priceRouteWETHtoDAI.destUSD) - parseFloat(priceRouteWETHtoDAI.srcUSD);

        // Estimate cost of DAI to WETH swap (This is a simplification, refine if needed)
        const repaymentCostUSD = parseFloat(priceRouteDAItoWETH.srcUSD) - parseFloat(priceRouteDAItoWETH.destUSD); // Cost is negative profit

        const netProfitUSD = grossProfitUSD + repaymentCostUSD; // Net profit after repayment swap cost

        console.log(`Gross profit (WETH -> DAI): $${grossProfitUSD.toFixed(4)}`);
        console.log(`Repayment cost (DAI -> WETH): $${repaymentCostUSD.toFixed(4)}`);
        console.log(`Net profit (after repayment swap): $${netProfitUSD.toFixed(4)}`);

        return netProfitUSD;
    } catch (error) {
        console.error('Profit calculation error for dual swap:', error);
        return -999;
    }
}

async function buildSwapTransaction(priceRoutes, srcToken, destToken, returnToken, loanAmountWei, userAddress) {
    try {
        const priceRouteWETHtoDAI = priceRoutes.priceRouteWETHtoDAI;
        const priceRouteDAItoWETH = priceRoutes.priceRouteDAItoWETH;

        console.log("WETH to DAI Price Route JSON:", JSON.stringify(priceRouteWETHtoDAI, null, 2));
        console.log("DAI to WETH Price Route JSON:", JSON.stringify(priceRouteDAItoWETH, null, 2));


        // --- Build WETH to DAI Swap Tx ---
        const expectedDAIAmount = BigInt(priceRouteWETHtoDAI.destAmount);
        const minAcceptableDAI = expectedDAIAmount * BigInt(Math.round((1 - (SLIPPAGE_PERCENT / 100)) * 10000)) / BigInt(10000);
        console.log("Expected Destination Amount (DAI) for WETH swap:", expectedDAIAmount.toString());
        console.log("Min Acceptable DAI for WETH swap:", minAcceptableDAI.toString());


        const txParamsWETHtoDAI = {
            srcToken,
            destToken,
            srcDecimals: 18,
            destDecimals: 18,
            srcAmount: loanAmountWei.toString(),
            slippage: SLIPPAGE_PERCENT * 100,
            deadline: Math.floor(Date.now() / 1000) + 600,
            partner: PARASWAP_PARTNERS.referrer,
            ignoreChecks: true,
            onlyParams: false,
            userAddress,
            priceRoute: priceRouteWETHtoDAI
        };

        console.log('Building WETH to DAI swap transaction with params:', txParamsWETHtoDAI);
        const responseWETHtoDAI = await paraSwap.swap.buildTx(txParamsWETHtoDAI);
        const txDataWETHtoDAI = responseWETHtoDAI.data;
        if (!txDataWETHtoDAI?.to || !txDataWETHtoDAI?.data) {
            throw new Error('Invalid WETH to DAI transaction data');
        }


        // --- Build DAI to WETH Repayment Swap Tx ---
        // Use the expected DAI amount from the first swap as input for the second swap
        const estimatedDAIToSwapForRepayment = BigInt(priceRouteWETHtoDAI.destAmount);

        const expectedWETHRepaymentAmount = BigInt(priceRouteDAItoWETH.destAmount); // Expected WETH back for repayment
        const minAcceptableWETHRepay = expectedWETHRepaymentAmount * BigInt(Math.round((1 - (SLIPPAGE_PERCENT / 100)) * 10000)) / BigInt(10000);
        console.log("Expected WETH amount for DAI repayment swap:", expectedWETHRepaymentAmount.toString());
        console.log("Min Acceptable WETH for DAI repayment swap:", minAcceptableWETHRepay.toString());


        const txParamsDAItoWETH = {
            srcToken: destToken, // DAI
            destToken: returnToken, // WETH
            srcDecimals: 18,
            destDecimals: 18,
            srcAmount: estimatedDAIToSwapForRepayment.toString(), // Use expected DAI from first swap
            slippage: SLIPPAGE_PERCENT * 100,
            deadline: Math.floor(Date.now() / 1000) + 600,
            partner: PARASWAP_PARTNERS.referrer,
            ignoreChecks: true,
            onlyParams: false,
            userAddress,
            priceRoute: priceRouteDAItoWETH
        };


        console.log('Building DAI to WETH repayment swap transaction with params:', txParamsDAItoWETH);
        const responseDAItoWETH = await paraSwap.swap.buildTx(txParamsDAItoWETH);
        const txDataDAItoWETH = responseDAItoWETH.data;
        if (!txDataDAItoWETH?.to || !txDataDAItoWETH?.data) {
            throw new Error('Invalid DAI to WETH transaction data');
        }


        return {
            txDataWETHtoDAI,
            txDataDAItoWETH,
            minAcceptableDAI,
            minAcceptableWETHRepay
        };

    } catch (error) {
        console.error('Error in buildSwapTransaction for dual swap:', error);
        throw error;
    }
}



// Updated executeFlashArbitrage function
async function executeFlashArbitrage(srcToken, destToken, returnToken, loanAmount) {
    try {
        const loanAmountWei = ethers.parseUnits(loanAmount, 18);
        console.log(`\n=== Processing Dual Swap Arbitrage with ${loanAmount} ETH flash loan ===`);

        const userAddress = await signer.getAddress();

        // Get price routes for both swaps
        const priceRoutes = await getPriceRoute(srcToken, destToken, returnToken, loanAmountWei);

        // Calculate net profit considering both swaps
        const netProfitUSD = await calculateNetProfit(priceRoutes, loanAmount);
        if (netProfitUSD < MIN_PROFIT_THRESHOLD_USD) {
            console.log(`Skipping - Below profit threshold for dual swap`);
            return;
        }


        // Build swap transactions for both WETH -> DAI and DAI -> WETH
        const swapTransactions = await buildSwapTransaction(priceRoutes, srcToken, destToken, returnToken, loanAmountWei, userAddress);
        const txDataWETHtoDAI = swapTransactions.txDataWETHtoDAI;
        const txDataDAItoWETH = swapTransactions.txDataDAItoWETH;
        const minAcceptableDAI = swapTransactions.minAcceptableDAI;
        const minAcceptableWETHRepay = swapTransactions.minAcceptableWETHRepay;


        // Encode parameters for the flash loan contract - now includes TWO swap datas and TWO slippage limits
        const encodedParams = ethers.AbiCoder.defaultAbiCoder().encode(
            ["address", "bytes", "address", "bytes", "uint256", "uint256"],
            [
                txDataWETHtoDAI.to,
                txDataWETHtoDAI.data,
                txDataDAItoWETH.to,
                txDataDAItoWETH.data,
                minAcceptableDAI,
                minAcceptableWETHRepay
            ]
        );


        console.log('Executing flash loan with dual swaps, params:', {
            loanAmount: ethers.formatEther(loanAmountWei),
            encodedParamsLength: encodedParams.length,
            minAcceptableDAI: minAcceptableDAI.toString(),
            minAcceptableWETHRepay: minAcceptableWETHRepay.toString()
        });


        // Execute flash loan with the dual swap strategy - **using the updated contract function name**
        const tx = await arbitrageContract.executeFlashLoanWithDualSwap(
            loanAmountWei,
            encodedParams,
            {
                gasLimit: 5_000_000,
            }
        );


        console.log('Flash loan transaction (Dual Swap) sent:', tx.hash);
        const receipt = await tx.wait();

        console.log('Dual Swap Transaction completed:', {
            status: receipt.status,
            gasUsed: receipt.gasUsed.toString(),
            effectiveGasPrice: ethers.formatUnits(receipt.effectiveGasPrice, 'gwei')
        });


    } catch (error) {
        console.error('\n=== Dual Swap Flash Loan Error Details ===');
        if (error.response?.data) {
            console.error('API Response:', error.response.data);
        }
        if (error.error?.error?.data) {
            const errorData = error.error.error.data;
            try {
                const decodedError = arbitrageContract.interface.parseError(errorData);
                console.error('Decoded contract error:', decodedError);
            } catch (e) {
                console.error('Raw error data:', errorData);
            }
        }
        throw error;
    }
}


// Monitor loop with improved error handling (modified to call dual swap arbitrage)
async function monitor() {
    console.log('🚀 Starting dual swap arbitrage monitor...');
    try {
        await ensureApprovals(); // Ensure approvals are checked at the beginning

        while (true) {
            try {
                for (const amount of LOAN_AMOUNTS) {
                    await executeFlashArbitrage(TOKENS.WETH.address, TOKENS.DAI.address, TOKENS.WETH.address, amount); // Pass returnToken as WETH now
                }
            } catch (error) {
                console.error('Cycle error in dual swap monitor:', error.message);
            }
            await new Promise(resolve => setTimeout(resolve, CHECK_INTERVAL));
        }
    } catch (error) {
        console.error('Fatal monitor error in dual swap monitor:', error);
        process.exit(1);
    }
}

// Add initial setup verification
async function verifySetup() {
    try {
        console.log('Verifying network connection...');
        const network = await provider.getNetwork();
        console.log(`Connected to network: ${network.name} (${network.chainId})`);

        console.log('Verifying signer...');
        const address = await signer.getAddress();
        const balance = await provider.getBalance(address);
        console.log(`Signer address: ${address}`);
        console.log(`Balance: ${ethers.formatEther(balance)} ETH`);

        return true;
    } catch (error) {
        console.error('Setup verification failed:', error);
        return false;
    }
}

// Main execution
async function main() {
    const setupOk = await verifySetup();
    if (setupOk) {
        await monitor();
    } else {
        console.error('Exiting due to setup verification failure');
        process.exit(1);
    }
}

main().catch(console.error);
