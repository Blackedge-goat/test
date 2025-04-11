const axios = require('axios');
const { ethers } = require('ethers');
const fs = require('fs');
require('dotenv').config();

// Token Registry System
class TokenRegistry {
    constructor(signer) {
        this.signer = signer;
        this.tokens = new Map();
        this.tokenContracts = new Map();
        this.ERC20_ABI = [
            'function decimals() view returns (uint8)',
            'function symbol() view returns (string)',
            'function allowance(address owner, address spender) view returns (uint256)',
            'function approve(address spender, uint256 amount) returns (bool)'
        ];
        
        // Add auto-update settings
        this.lastUpdate = new Date(0);
        this.pairPerformance = new Map();
    }

    async addToken(address) {
        if (this.tokens.has(address.toLowerCase())) {
            return this.tokens.get(address.toLowerCase());
        }

        try {
            const contract = new ethers.Contract(address, this.ERC20_ABI, this.signer);
            const [decimals, symbol] = await Promise.all([
                contract.decimals(),
                contract.symbol()
            ]);

            const tokenInfo = {
                address,
                decimals,
                symbol,
                abi: this.ERC20_ABI
            };

            this.tokens.set(address.toLowerCase(), tokenInfo);
            this.tokenContracts.set(address.toLowerCase(), contract);
            
            console.log(`Added token ${symbol} (${address}) with ${decimals} decimals`);
            return tokenInfo;
        } catch (error) {
            console.error(`Failed to add token ${address}:`, error);
            throw error;
        }
    }

    async getTokenContract(address) {
        address = address.toLowerCase();
        if (!this.tokenContracts.has(address)) {
            await this.addToken(address);
        }
        return this.tokenContracts.get(address);
    }

    async getTokenInfo(address) {
        address = address.toLowerCase();
        if (!this.tokens.has(address)) {
            await this.addToken(address);
        }
        return this.tokens.get(address);
    }

    async loadTokenPairs() {
        const topPairs = JSON.parse(fs.readFileSync('./top_pairs.json', 'utf-8'));
        
        for (const pair of topPairs) {
            await Promise.all([
                this.addToken(pair.base),
                this.addToken(pair.quote)
            ]);
        }
        
        return topPairs;
    }

    async updatePairPerformance(pairKey, tradeResult) {
        if (!this.pairPerformance.has(pairKey)) {
            this.pairPerformance.set(pairKey, {
                successCount: 0,
                totalTrades: 0,
                totalProfit: 0,
                volumeUSD: 0,
                profits: [],
                lastUpdate: new Date()
            });
        }

        const stats = this.pairPerformance.get(pairKey);
        stats.totalTrades++;
        stats.volumeUSD += tradeResult.volumeUSD;
        stats.totalProfit += tradeResult.profitUSD;
        stats.profits.push({
            timestamp: new Date(),
            profit: tradeResult.profitUSD
        });
        
        if (tradeResult.profitUSD > 0) {
            stats.successCount++;
        }

        // Keep only last 100 trades for volatility calculation
        if (stats.profits.length > 100) {
            stats.profits.shift();
        }

        // Auto-update top_pairs.json if needed
        await this.checkAndUpdatePairs();
    }

    async checkAndUpdatePairs() {
        const now = new Date();
        const topPairs = JSON.parse(fs.readFileSync('./top_pairs.json', 'utf-8'));
        
        // Check if update is needed based on interval
        if (now - new Date(topPairs.lastUpdated) < topPairs.updateInterval * 1000) {
            return;
        }

        // Process performance data
        const pairMetrics = Array.from(this.pairPerformance.entries())
            .map(([pairKey, stats]) => {
                const [base, quote] = pairKey.split('-');
                return {
                    base,
                    quote,
                    metrics: {
                        successRate: stats.successCount / stats.totalTrades,
                        averageProfit: stats.totalProfit / stats.totalTrades,
                        volumeUSD: stats.volumeUSD,
                        trades: stats.totalTrades,
                        lastProfit: stats.profits[stats.profits.length - 1]?.profit || 0,
                        volatilityScore: this.calculateVolatility(stats.profits)
                    }
                };
            })
            .filter(pair => pair.metrics.trades >= topPairs.minDataPoints);

        // Sort by profitability and success rate
        pairMetrics.sort((a, b) => {
            const scoreA = a.metrics.averageProfit * a.metrics.successRate;
            const scoreB = b.metrics.averageProfit * a.metrics.successRate;
            return scoreB - scoreA;
        });

        // Update top pairs
        topPairs.pairs = pairMetrics.slice(0, 10).map(pair => ({
            base: pair.base,
            quote: pair.quote,
            address: this.tokens.get(pair.quote.toLowerCase())?.address,
            expectedProfitMin: Math.max(0.1, pair.metrics.averageProfit * 0.7),
            optimalSize: this.calculateOptimalSize(pair.metrics),
            historicalVolatility: this.categorizeVolatility(pair.metrics.volatilityScore),
            liquidityScore: this.calculateLiquidityScore(pair.metrics),
            timeWindow: "24h",
            performanceMetrics: pair.metrics
        }));

        // Update watchlist with promising new pairs
        const watchlistCandidates = pairMetrics
            .slice(10)
            .filter(pair => {
                const metrics = pair.metrics;
                return metrics.successRate > 0.6 && metrics.averageProfit > 0.3;
            })
            .slice(0, 5);

        topPairs.watchlist = watchlistCandidates.map(pair => ({
            base: pair.base,
            quote: pair.quote,
            address: this.tokens.get(pair.quote.toLowerCase())?.address,
            monitoringSince: new Date().toISOString(),
            dataPoints: pair.metrics.trades,
            preliminaryMetrics: {
                averageProfit: pair.metrics.averageProfit,
                successRate: pair.metrics.successRate,
                volatilityScore: pair.metrics.volatilityScore
            }
        }));

        topPairs.lastUpdated = now.toISOString();

        // Save updated top_pairs.json
        fs.writeFileSync('./top_pairs.json', JSON.stringify(topPairs, null, 2));
        console.log('Updated top_pairs.json with new performance metrics');
    }

    calculateVolatility(profits) {
        if (profits.length < 2) return 0;
        const values = profits.map(p => p.profit);
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length;
        return Math.sqrt(variance) / mean; // Coefficient of variation
    }

    calculateOptimalSize(metrics) {
        const baseSize = (metrics.volumeUSD / metrics.trades) / 4000; // Assuming WETH price ~$4000
        const adjustedSize = baseSize * (0.5 + metrics.successRate);
        return Math.min(Math.max(adjustedSize, 0.1), 5.0).toFixed(1); // Between 0.1 and 5.0 ETH
    }

    categorizeVolatility(score) {
        if (score < 0.1) return "low";
        if (score < 0.25) return "medium";
        return "high";
    }

    calculateLiquidityScore(metrics) {
        const volumeScore = Math.min(metrics.volumeUSD / 1000000, 1); // Scale based on $1M daily volume
        const tradeScore = Math.min(metrics.trades / 100, 1); // Scale based on 100 trades
        return ((volumeScore + tradeScore) / 2).toFixed(2);
    }
}

// Load token pairs from JSON
const topPairs = JSON.parse(fs.readFileSync('./top_pairs.json', 'utf-8'));

// Token Configuration
const ERC20_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external'
];

const TOKENS = {
  DAI: {
    address: '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1',
    decimals: 18,
    abi: ERC20_ABI
  },
  USDC: {
    address: '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8',
    decimals: 6,
    abi: ERC20_ABI
  },
  USDT: {
    address: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
    decimals: 6,
    abi: ERC20_ABI
  },
  WETH: {
    address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    decimals: 18,
    abi: ERC20_ABI
  },
  LINK: {
    address: '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4',
    decimals: 18,
    abi: ERC20_ABI
  },
  SPELL: {
    address: '0x3e6648c5a70a150a88804ec3240d3499b897234',
    decimals: 18,
    abi: ERC20_ABI
  },
  ORDER: {
    address: '0x242301fa62f0de9e3842a5fb4c0cdca67e3a2fab',
    decimals: 18,
    abi: ERC20_ABI
  },
  MAGIC: {
    address: '0x539bde0d7dbd336b79148aa742883198bbf60342',
    decimals: 18,
    abi: ERC20_ABI
  },
  SFUND: {
    address: '0x560BBfe669D6F37495DACA18fE42eB440b69e38A',
    decimals: 18,
    abi: ERC20_ABI
  },
  DEGEN: {
    address: '0x4c4b0A26Dd8538De31A51Da26c7AdC0794E45E17',
    decimals: 18,
    abi: ERC20_ABI
  }
};

// Set up WebSocket provider
const WS_PROVIDER_URL = 'wss://arb-mainnet.g.alchemy.com/v2/k_YSndd71jVwonn97UkeLDLuABfcW83A';
const wsProvider = new ethers.WebSocketProvider(WS_PROVIDER_URL);
const provider = wsProvider; // Use WebSocket provider as the main provider

// Set up WebSocket error handling and auto-reconnect
wsProvider.on('error', (error) => {
    console.error('WebSocket Error:', error);
    reconnectWebSocket();
});

wsProvider.on('disconnect', (error) => {
    console.log('WebSocket Disconnected:', error);
    reconnectWebSocket();
});

async function reconnectWebSocket() {
    console.log('Attempting to reconnect WebSocket...');
    try {
        await wsProvider.destroy(); // Clean up existing connection
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
        await wsProvider.connect();
        console.log('WebSocket reconnected successfully');
    } catch (error) {
        console.error('WebSocket reconnection failed:', error);
        // Try again in 5 seconds
        setTimeout(reconnectWebSocket, 5000);
    }
}

// Path tracking and prioritization
class TokenPath {
    constructor(srcToken, destToken, returnToken, id) {
        this.srcToken = srcToken;
        this.destToken = destToken;
        this.returnToken = returnToken;
        this.id = id;
        this.lastChecked = 0;
        this.successRate = 0;
        this.totalAttempts = 0;
        this.successfulAttempts = 0;
        this.averageProfit = 0;
        this.totalProfit = 0;
        this.volatilityScore = 0;
        this.liquidityScore = 1;
        this.priceHistory = [];
    }

    updateStats(wasSuccessful, profit = 0, liquidityDepth = 1) {
        this.totalAttempts++;
        if (wasSuccessful) {
            this.successfulAttempts++;
            this.totalProfit += profit;
        }
        this.successRate = this.successfulAttempts / this.totalAttempts;
        this.averageProfit = this.totalProfit / this.successfulAttempts || 0;
        this.liquidityScore = liquidityDepth;
        this.lastChecked = Date.now();
    }

    updatePriceHistory(price) {
        const MAX_HISTORY = 10;
        this.priceHistory.push({ price, timestamp: Date.now() });
        if (this.priceHistory.length > MAX_HISTORY) {
            this.priceHistory.shift();
        }
        this.calculateVolatility();
    }

    calculateVolatility() {
        if (this.priceHistory.length < 2) return;
        
        const returns = [];
        for (let i = 1; i < this.priceHistory.length; i++) {
            const return_ = (this.priceHistory[i].price - this.priceHistory[i-1].price) / this.priceHistory[i-1].price;
            returns.push(return_);
        }
        
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
        this.volatilityScore = Math.sqrt(variance);
    }

    getScore() {
        const now = Date.now();
        const recencyScore = Math.exp(-(now - this.lastChecked) / (5 * 60 * 1000)); // 5 minute decay
        const profitScore = this.averageProfit * this.successRate;
        const volatilityOpportunityScore = this.volatilityScore * 2; // Higher volatility means more opportunities
        
        return (
            profitScore * 0.4 +
            recencyScore * 0.2 +
            this.liquidityScore * 0.2 +
            volatilityOpportunityScore * 0.2
        );
    }
}

class PriorityQueue {
    constructor() {
        this.paths = new Map();
        this.lastProcessed = new Map();
    }

    addPath(path) {
        this.paths.set(path.id, path);
    }

    getNextPaths(count = 3) {
        const now = Date.now();
        const COOLDOWN = 30000; // 30 second cooldown between checks

        return Array.from(this.paths.values())
            .filter(path => now - (this.lastProcessed.get(path.id) || 0) > COOLDOWN)
            .sort((a, b) => b.getScore() - a.getScore())
            .slice(0, count);
    }

    updatePathStatus(pathId, wasSuccessful, profit, liquidityDepth) {
        const path = this.paths.get(pathId);
        if (path) {
            path.updateStats(wasSuccessful, profit, liquidityDepth);
            this.lastProcessed.set(pathId, Date.now());
        }
    }
}

// Initialize token paths and priority queue
const pathQueue = new PriorityQueue();

// Define token paths dynamically from top_pairs.json
const TOKEN_PATHS = topPairs.map(pair => {
    const pathId = `${pair.base}-${pair.quote}`;
    return new TokenPath(
        TOKENS[pair.base].address,
        TOKENS[pair.quote].address,
        TOKENS[pair.base].address, // Return token is always the base token
        pathId
    );
});

// Add all paths to the queue
TOKEN_PATHS.forEach(path => pathQueue.addPath(path));

const CHAIN_ID = 42161; // Arbitrum
const CONTRACT_ADDRESS = '0xbc72a11f1482d3884a6fd4f7bbb0201add8a0d0a'; // DualSwap contract address
const CHECK_INTERVAL = 5000;
const MIN_PROFIT_THRESHOLD_USD =0.01;
const LOAN_AMOUNTS = ['1'];
const SLIPPAGE_PERCENT = 1; // 1%

// Initialize Ethereum components
const signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

// Create token contract instances (for approvals, etc.)
const tokenContracts = {
  WETH: new ethers.Contract(TOKENS.WETH.address, TOKENS.WETH.abi, signer),
  SPELL: new ethers.Contract(TOKENS.SPELL.address, TOKENS.SPELL.abi, signer),
  ORDER: new ethers.Contract(TOKENS.ORDER.address, TOKENS.ORDER.abi, signer),
  MAGIC: new ethers.Contract(TOKENS.MAGIC.address, TOKENS.MAGIC.abi, signer),
  SFUND: new ethers.Contract(TOKENS.SFUND.address, TOKENS.SFUND.abi, signer),
  DEGEN: new ethers.Contract(TOKENS.DEGEN.address, TOKENS.DEGEN.abi, signer)
};

// Allowed DEXs (for route calculation)
const ALLOWED_DEXS = ['CamelotV3', 'PancakeSwapV3', 'UniswapV3', 'Sushiswap'];

// Helper: get token decimals by address
function getTokenDecimals(tokenAddress) {
  tokenAddress = tokenAddress.toLowerCase();
  for (const key in TOKENS) {
    if (TOKENS[key].address.toLowerCase() === tokenAddress) {
      return TOKENS[key].decimals;
    }
  }
  return 18;
}

// Delay helper (in ms)
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Initialize Dual Swap Contract
const arbitrageContract = new ethers.Contract(
  CONTRACT_ADDRESS,
  [
    {
      "inputs": [
        { "internalType": "uint256", "name": "amount", "type": "uint256" },
        { "internalType": "bytes", "name": "params", "type": "bytes" }
      ],
      "name": "executeFlashLoanWithDualSwap",
      "outputs":[],
      "stateMutability": "nonpayable",
      "type": "function"
    },
    ...require('./FlashLoanArbitrageABI.json')
  ],
  signer
);

// Helper: generate permit signature

// Helper: generate permit signature
async function generatePermitSignature(tokenContract, owner, spender, value, deadline) {
    try {
      // First check if the contract even has the necessary methods
      if (!tokenContract.nonces || !tokenContract.name) {
        console.log(`Skipping permit for token at ${tokenContract.target} - No EIP-2612 support`);
        return null; // Return null if permit isn't supported
      }
  
      // Try to call name() function to see if it exists and works
      let tokenName;
      try {
        tokenName = await tokenContract.name();
      } catch (error) {
        console.log(`Token at ${tokenContract.target} doesn't support name() function. Falling back to approve()`);
        return null;
      }
  
      // Continue only if we have a valid token name
      const nonce = await tokenContract.nonces(owner);
      const domain = {
        name: tokenName,
        version: '1',
        chainId: CHAIN_ID,
        verifyingContract: tokenContract.target
      };
      const types = {
        Permit: [
          { name: 'owner', type: 'address' },
          { name: 'spender', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' }
        ]
      };
      const message = { owner, spender, value, nonce, deadline };
      const signature = await signer.signTypedData(domain, types, message);
      const { v, r, s } = ethers.Signature.from(signature);
      return { v, r, s };
    } catch (error) {
      console.error(`Permit signature generation failed for token at ${tokenContract.target}. Error: ${error.message}. Falling back to approve()`);
      return null; // Ensure the script falls back to standard approval
    }
  }
// Updated ensureApprovals function for direct DEX interactions
async function ensureApprovals() {
  try {
    const dexRouters = {
      UniswapV3: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
      CamelotV3: '0xc873fEcbd354f5A56E00E710B90EF4201db2448d',
      SushiSwap: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506'
    };
    const arbitrageContractAddress = CONTRACT_ADDRESS;
    const userAddress = await signer.getAddress();

    console.log('Verifying approvals for DEX routers and arbitrage contract...');

    for (const tokenSymbol in tokenContracts) {
      const contract = tokenContracts[tokenSymbol];

      // Check and set approvals for each DEX router
      for (const [dexName, routerAddress] of Object.entries(dexRouters)) {
        let allowance = await contract.allowance(userAddress, routerAddress);
        console.log(`${tokenSymbol} allowance for ${dexName}: ${ethers.formatUnits(allowance, getTokenDecimals(TOKENS[tokenSymbol].address))}`);
        
        if (allowance === 0n) {
          console.log(`Approving ${tokenSymbol} for ${dexName}...`);
          const tx = await contract.approve(routerAddress, ethers.MaxUint256);
          console.log(`Approval transaction sent for ${dexName}: ${tx.hash}`);
          const receipt = await tx.wait();
          console.log(`${tokenSymbol} approved for ${dexName}. Gas used: ${receipt.gasUsed.toString()}`);
          await delay(1000);
        }
      }

      // Check Arbitrage Contract allowance
      let allowance = await contract.allowance(userAddress, arbitrageContractAddress);
      console.log(`${tokenSymbol} allowance for Arbitrage Contract: ${ethers.formatUnits(allowance, getTokenDecimals(TOKENS[tokenSymbol].address))}`);
      
      if (allowance === 0n) {
        console.log(`Approving ${tokenSymbol} for Arbitrage Contract...`);
        const deadline = Math.floor(Date.now() / 1000) + 600;
        const permitSignature = await generatePermitSignature(contract, userAddress, arbitrageContractAddress, ethers.MaxUint256, deadline);
        
        if (permitSignature) {
          console.log(`Using permit for ${tokenSymbol} approval...`);
          const tx = await contract.permit(
            userAddress,
            arbitrageContractAddress,
            ethers.MaxUint256,
            deadline,
            permitSignature.v,
            permitSignature.r,
            permitSignature.s
          );
          await tx.wait();
        } else {
          console.log(`Falling back to regular approval for ${tokenSymbol}...`);
          const tx = await contract.approve(arbitrageContractAddress, ethers.MaxUint256);
          console.log(`Approval transaction sent for Arbitrage Contract: ${tx.hash}`);
          const receipt = await tx.wait();
          console.log(`${tokenSymbol} approved for Arbitrage Contract. Gas used: ${receipt.gasUsed.toString()}`);
        }
        await delay(1000);
      }
    }
    console.log('All necessary approvals confirmed.');
  } catch (error) {
    console.error('Approval verification failed:', error);
    throw error;
  }
}

// Helper functions for DEX interactions
async function getUniswapPrice(tokenIn, tokenOut, amountIn) {
    const quoterAddress = '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6'; // Uniswap V3 Quoter
    const quoterAbi = [
        'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)'
    ];
    const quoter = new ethers.Contract(quoterAddress, quoterAbi, provider);
    
    try {
        const amountOut = await quoter.quoteExactInputSingle(
            tokenIn,
            tokenOut,
            3000, // default fee tier
            amountIn,
            0
        );
        return amountOut;
    } catch (error) {
        console.error('Error getting Uniswap price:', error);
        return 0n;
    }
}

async function getCamelotPrice(tokenIn, tokenOut, amountIn) {
    const routerAddress = '0xc873fEcbd354f5A56E00E710B90EF4201db2448d'; // Camelot V3 Router
    const routerAbi = [
        'function getAmountOut(uint256 amountIn, address tokenIn, address tokenOut) external view returns (uint256 amountOut)'
    ];
    const router = new ethers.Contract(routerAddress, routerAbi, provider);
    
    try {
        const amountOut = await router.getAmountOut(amountIn, tokenIn, tokenOut);
        return amountOut;
    } catch (error) {
        console.error('Error getting Camelot price:', error);
        return 0n;
    }
}

async function getSushiSwapPrice(tokenIn, tokenOut, amountIn) {
    const routerAddress = '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506'; // SushiSwap Router
    const routerAbi = [
        'function getAmountOut(uint amountIn, address tokenIn, address tokenOut) external view returns (uint amountOut)'
    ];
    const router = new ethers.Contract(routerAddress, routerAbi, provider);
    
    try {
        const amountOut = await router.getAmountOut(amountIn, tokenIn, tokenOut);
        return amountOut;
    } catch (error) {
        console.error('Error getting SushiSwap price:', error);
        return 0n;
    }
}

async function getBestPrice(tokenIn, tokenOut, amountIn) {
    const [uniswapPrice, camelotPrice, sushiPrice] = await Promise.all([
        getUniswapPrice(tokenIn, tokenOut, amountIn),
        getCamelotPrice(tokenIn, tokenOut, amountIn),
        getSushiSwapPrice(tokenIn, tokenOut, amountIn)
    ]);

    const prices = [
        { dex: 'Uniswap', amount: uniswapPrice },
        { dex: 'Camelot', amount: camelotPrice },
        { dex: 'SushiSwap', amount: sushiPrice }
    ].filter(p => p.amount > 0n);

    if (prices.length === 0) return null;

    return prices.reduce((best, current) => 
        current.amount > best.amount ? current : best
    );
}

// Updated version of buildSwapTransaction without ParaSwap
async function buildSwapTransaction(srcToken, destToken, returnToken, loanAmountWei, userAddress) {
    try {
        console.log("Building swap transactions...");

        // Get best prices for both swaps
        const swap1 = await getBestPrice(srcToken, destToken, loanAmountWei);
        if (!swap1) throw new Error('No valid route found for first swap');

        const expectedDestAmount = swap1.amount;
        const minAcceptableDest = expectedDestAmount *
            BigInt(Math.round((1 - (SLIPPAGE_PERCENT / 100)) * 10000)) /
            BigInt(10000);

        // Simulate first swap result
        const actualDestAmount = await simulateSwapResult(expectedDestAmount);
        
        // Get best price for second swap using simulated output
        const swap2 = await getBestPrice(destToken, returnToken, actualDestAmount);
        if (!swap2) throw new Error('No valid route found for second swap');

        const expectedReturnAmount = swap2.amount;
        const minAcceptableReturn = expectedReturnAmount *
            BigInt(Math.round((1 - (SLIPPAGE_PERCENT / 100)) * 10000)) /
            BigInt(10000);

        return {
            swap1Dex: swap1.dex,
            swap2Dex: swap2.dex,
            expectedDestAmount,
            minAcceptableDest,
            expectedReturnAmount,
            minAcceptableReturn
        };
    } catch (error) {
        console.error('Error in buildSwapTransaction:', error.message);
        throw error;
    }
}

async function getSpender() {
  try {
    const spender = await paraSwap.swap.getSpender();
    if (!ethers.isAddress(spender)) throw new Error('Invalid spender address returned from ParaSwap');
    return spender;
  } catch (error) {
    console.error('Failed to get ParaSwap spender:', error.message);
    return '0xdef171fe48cf0115b1d80b88dc8eab59176fee57';
  }
}

// Helper: simulate actual output from Swap1; replace with your simulation logic if available.
/**
 * Simulates the actual output from a swap with dynamic market conditions
 * @param {BigInt} expectedDestAmount - The expected destination amount from the quote
 * @param {Object} options - Additional options for the simulation
 * @returns {Promise<BigInt>} - The simulated actual amount received after swap
 */
async function simulateSwapResult(expectedDestAmount, options = {}) {
  try {
    const {
      tokenVolatility = 'medium', // 'low', 'medium', 'high'
      marketDirection = 'neutral', // 'up', 'down', 'neutral'
      swapSize = 'medium', // 'small', 'medium', 'large'
      dex = 'generic', // 'uniswap', 'curve', 'balancer', 'generic'
      timeDelay = 'normal', // 'fast', 'normal', 'slow'
      gasPrice = 'normal' // 'low', 'normal', 'high'
    } = options;
    
    // Base loss factors by volatility (parts per 1000)
    const volatilityFactors = {
      low: { min: 990n, max: 998n },      // 0.2% - 1.0% loss
      medium: { min: 985n, max: 995n },   // 0.5% - 1.5% loss
      high: { min: 975n, max: 990n }      // 1.0% - 2.5% loss
    };
    
    // Market direction adjustments (parts per 1000)
    const directionAdjustments = {
      up: 5n,     // +0.5% (less slippage in rising market)
      neutral: 0n, // no change
      down: -5n    // -0.5% (more slippage in falling market)
    };
    
    // Swap size impacts (parts per 1000)
    const sizeImpacts = {
      small: 3n,   // +0.3% (less slippage for small swaps)
      medium: 0n,  // no change
      large: -7n   // -0.7% (more slippage for large swaps)
    };
    
    // DEX-specific factors (parts per 1000)
    const dexFactors = {
      uniswap: 0n,    // baseline
      curve: -2n,     // -0.2% (curve tends to have slightly more slippage)
      balancer: 1n,   // +0.1% (balancer tends to have slightly less slippage)
      generic: -3n    // -0.3% (unknown/aggregated DEXs have more variance)
    };
    
    // Time delay impacts (parts per 1000)
    const timeDelayImpacts = {
      fast: 2n,    // +0.2% (less slippage if execution is quick)
      normal: 0n,  // no change
      slow: -5n    // -0.5% (more slippage if execution is slow)
    };
    
    // Gas price impacts on priority (parts per 1000)
    const gasPriceImpacts = {
      low: -3n,     // -0.3% (lower priority may lead to more slippage)
      normal: 0n,   // no change
      high: 2n      // +0.2% (higher priority may lead to less slippage)
    };
    
    // Calculate base factor range based on volatility
    const { min, max } = volatilityFactors[tokenVolatility];
    
    // Add randomness within the volatility range
    const randomInRange = min + (BigInt(Math.floor(Math.random() * Number(max - min + 1n))));
    
    // Apply all adjustments
    let adjustedFactor = randomInRange;
    adjustedFactor += directionAdjustments[marketDirection] || 0n;
    adjustedFactor += sizeImpacts[swapSize] || 0n;
    adjustedFactor += dexFactors[dex] || 0n;
    adjustedFactor += timeDelayImpacts[timeDelay] || 0n;
    adjustedFactor += gasPriceImpacts[gasPrice] || 0n;
    
    // Ensure factor doesn't exceed reasonable bounds (97% - 100%)
    adjustedFactor = adjustedFactor < 970n ? 970n : adjustedFactor;
    adjustedFactor = adjustedFactor > 1000n ? 1000n : adjustedFactor;
    
    // Apply the calculated factor to the expected amount
    const actualAmount = (expectedDestAmount * adjustedFactor) / 1000n;
    
    console.log(`Simulation details for swap - Expected: ${expectedDestAmount}, Actual: ${actualAmount}`);
    console.log(`Applied factor: ${Number(adjustedFactor)/10}% (${adjustedFactor}/1000)`);
    
    return actualAmount;
  } catch (error) {
    console.error("Error simulating swap result:", error);
    // Default to a conservative 1% slippage in case of error
    return (expectedDestAmount * 990n) / 1000n;
  }
}

/**
 * Simulates both swaps in an arbitrage opportunity to verify profitability
 * @param {Object} swap1Details - Details about the first swap
 * @param {Object} swap2Details - Details about the second swap
 * @param {BigInt} flashLoanAmount - Amount of the flash loan
 * @param {BigInt} flashLoanFee - Fee for the flash loan (e.g., 9n for 0.09%)
 * @returns {Promise<Object>} - Simulation results and profitability analysis
 */
async function simulateArbitrageOpportunity(swap1Details, swap2Details, flashLoanAmount, flashLoanFee = 9n) {
  try {
    // Extract expected outputs
    const expectedOutput1 = swap1Details.expectedOut;
    
    // Simulate first swap with params reflecting current market
    const actualOutput1 = await simulateSwapResult(expectedOutput1, {
      tokenVolatility: swap1Details.tokenVolatility || 'medium',
      marketDirection: swap1Details.marketDirection || 'neutral',
      swapSize: swap1Details.swapSize || 'medium',
      dex: swap1Details.dex || 'generic'
    });
    
    // Update second swap expectation based on actual output from first swap
    const updatedExpectedOutput2 = (swap2Details.expectedOut * actualOutput1) / expectedOutput1;
    
    // Simulate second swap
    const actualOutput2 = await simulateSwapResult(updatedExpectedOutput2, {
      tokenVolatility: swap2Details.tokenVolatility || 'medium',
      marketDirection: swap2Details.marketDirection || 'neutral',
      swapSize: swap2Details.swapSize || 'medium',
      dex: swap2Details.dex || 'generic'
    });
    
    // Calculate required repayment with fee
    const requiredRepayment = flashLoanAmount + ((flashLoanAmount * flashLoanFee) / 1000n);
    
    // Calculate profit and metrics
    const profit = actualOutput2 - requiredRepayment;
    const profitPercentage = (Number(profit) / Number(flashLoanAmount)) * 100;
    const bufferAmount = actualOutput2 - requiredRepayment;
    const bufferPercentage = (Number(bufferAmount) / Number(requiredRepayment)) * 100;
    
    return {
      expectedOutput1,
      actualOutput1,
      expectedOutput2: updatedExpectedOutput2,
      actualOutput2,
      requiredRepayment,
      profit,
      profitPercentage,
      bufferAmount,
      bufferPercentage,
      isProfitable: profit > 0n,
      isSafe: bufferPercentage > 0.5, // Consider safe if buffer is at least 0.5%
      executionRecommendation: bufferPercentage > 1.5 ? 'EXECUTE' : 
                              bufferPercentage > 0.5 ? 'CAUTION' : 'SKIP'
    };
  } catch (error) {
    console.error("Error simulating arbitrage opportunity:", error);
    return {
      error: error.message,
      isProfitable: false,
      isSafe: false,
      executionRecommendation: 'SKIP'
    };
  }
}

async function calculateNetProfit(priceRoutes, _loanAmount) {
  try {
    const { priceRouteSwap1, priceRouteSwap2 } = priceRoutes;
    const grossProfitUSD = parseFloat(priceRouteSwap1.destUSD) - parseFloat(priceRouteSwap1.srcUSD);
    const repaymentCostUSD = parseFloat(priceRouteSwap2.srcUSD) - parseFloat(priceRouteSwap2.destUSD);
    const netProfitUSD = grossProfitUSD - repaymentCostUSD;

    console.log(`Gross profit (swap1): $${grossProfitUSD.toFixed(4)}`);
    console.log(`Repayment cost (swap2): $${repaymentCostUSD.toFixed(4)}`);
    console.log(`Net profit (after repayment swap): $${netProfitUSD.toFixed(4)}`);

    return netProfitUSD;
  } catch (error) {
    console.error('Profit calculation error for dual swap:', error);
    return -999;
  }
}

// Updated executeFlashArbitrage function to use direct DEX interactions
async function executeFlashArbitrage(srcToken, destToken, returnToken, loanAmount) {
  try {
    const loanAmountWei = ethers.parseUnits(loanAmount, getTokenDecimals(srcToken));
    console.log(`\n=== Processing Dual Swap Arbitrage with ${loanAmount} flash loan ===`);
    
    // Initialize mempool analyzer
    const mempoolAnalyzer = new MempoolAnalyzer(provider);
    await mempoolAnalyzer.start();
    
    const userAddress = await signer.getAddress();

    // Get best swap routes and prices
    const swapDetails = await buildSwapTransaction(srcToken, destToken, returnToken, loanAmountWei, userAddress);
    
    // Off-Chain Repayment Check
    const FLASHLOAN_PREMIUM_BPS = 9n;
    const requiredRepayment = loanAmountWei + (loanAmountWei * FLASHLOAN_PREMIUM_BPS / 10000n);
    const expectedReturn = swapDetails.expectedReturnAmount;

    console.log(`Expected return from swap2: ${expectedReturn.toString()}`);
    console.log(`Required repayment (flash loan + fee): ${requiredRepayment.toString()}`);

    if (expectedReturn < requiredRepayment) {
      console.error("Off-chain check: Expected return is insufficient to cover flash loan repayment. Aborting transaction.");
      mempoolAnalyzer.stop();
      return;
    }
    
    // Run simulation
    const simulation = await simulateArbitrageOpportunity(
      {
        expectedOut: swapDetails.expectedDestAmount,
        tokenVolatility: 'high',
        dex: swapDetails.swap1Dex,
        marketDirection: 'neutral'
      },
      {
        expectedOut: expectedReturn,
        tokenVolatility: 'high',
        dex: swapDetails.swap2Dex
      },
      loanAmountWei,
      FLASHLOAN_PREMIUM_BPS
    );
    
    // Check if mempool conditions are favorable
    if (!mempoolAnalyzer.shouldExecute(srcToken, loanAmountWei)) {
      console.log("Unfavorable mempool conditions detected. Delaying execution.");
      mempoolAnalyzer.stop();
      return false;
    }
    
    console.log("Simulation results:", {
      expectedProfit: ethers.formatUnits(simulation.profit, getTokenDecimals(srcToken)),
      bufferPercentage: simulation.bufferPercentage.toFixed(2) + "%",
      recommendation: simulation.executionRecommendation
    });
    
    if (simulation.executionRecommendation === 'SKIP') {
      console.log("Skipping transaction due to simulation results - insufficient safety buffer");
      mempoolAnalyzer.stop();
      return false;
    }
    
    // Calculate optimal gas price based on expected profit
    const expectedProfitETH = Number(ethers.formatEther(simulation.profit));
    const expectedProfitUSD = expectedProfitETH * 4000; // Using approximate ETH price, should be dynamic in production
    
    const gasSettings = await mempoolAnalyzer.calculateOptimalGas(
      expectedProfitUSD,
      simulation.executionRecommendation === 'CAUTION' ? 'high' : 'normal'
    );
    
    console.log("Optimized gas settings:", {
      maxFeePerGas: ethers.formatUnits(gasSettings.maxFeePerGas, 'gwei'),
      maxPriorityFeePerGas: ethers.formatUnits(gasSettings.maxPriorityFeePerGas, 'gwei'),
      congestionLevel: gasSettings.congestionLevel,
      volatility: gasSettings.volatility
    });
    
    // Encode the swap parameters for the flash loan
    const encodedParams = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256", "address", "uint256", "uint256", "uint256"],
      [
        destToken,                    // intermediateToken
        swapDetails.minAcceptableDest,  // minReturnAmount1
        returnToken,                  // returnToken
        swapDetails.minAcceptableReturn, // minReturnAmount2
        0,                           // deadline
        0                            // permitData (not using permit in this version)
      ]
    );

    console.log('Executing flash loan with optimized parameters:', {
      loanAmount: ethers.formatUnits(loanAmountWei, getTokenDecimals(srcToken)),
      minAcceptableDest: swapDetails.minAcceptableDest.toString(),
      minAcceptableReturn: swapDetails.minAcceptableReturn.toString(),
      maxFeePerGas: ethers.formatUnits(gasSettings.maxFeePerGas, 'gwei')
    });

    const tx = await arbitrageContract.executeFlashLoanWithDualSwap(
      loanAmountWei,
      encodedParams,
      {
        gasLimit: 5_000_000,
        maxFeePerGas: gasSettings.maxFeePerGas,
        maxPriorityFeePerGas: gasSettings.maxPriorityFeePerGas
      }
    );

    console.log('Flash loan transaction sent:', tx.hash);
    const receipt = await tx.wait();
    console.log('Transaction completed:', {
      status: receipt.status,
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPrice: ethers.formatUnits(receipt.effectiveGasPrice, 'gwei'),
      actualGasCost: ethers.formatEther(receipt.gasUsed * receipt.effectiveGasPrice)
    });
    
    // Clean up
    mempoolAnalyzer.stop();
    return true;
  } catch (error) {
    console.error('\n=== Flash Loan Error ===');
    if (error.error && error.error.error && error.error.error.data) {
      try {
        const decodedError = arbitrageContract.interface.parseError(error.error.error.data);
        console.error('Contract Error:', decodedError.name);
      } catch (e) {
        console.error('Raw contract error occurred');
      }
    }
    console.error('Error:', error.message);
    mempoolAnalyzer.stop();
    throw error;
  }
}
  async function isProfitableOpportunity(srcToken, destToken, returnToken, loanAmount) {
    if (srcToken.toLowerCase() !== returnToken.toLowerCase()) {
      console.error("Profit check failed: The in token must equal the return token.");
      return false;
    }
    
    try {
      const loanAmountWei = ethers.parseUnits(loanAmount, getTokenDecimals(srcToken));
      const priceRoutes = await getPriceRoute(srcToken, destToken, returnToken, loanAmountWei);
      
      // Basic profit check using current quotes
      const basicNetProfitUSD = await calculateNetProfit(priceRoutes, loanAmount);
      
      // If it's not even profitable with current quotes, no need to simulate
      if (basicNetProfitUSD < MIN_PROFIT_THRESHOLD_USD) {
        console.log(`Basic profit check failed: $${basicNetProfitUSD.toFixed(2)} < $${MIN_PROFIT_THRESHOLD_USD}`);
        return false;
      }
      
      // Run simulation for a more realistic profit estimate
      const FLASHLOAN_PREMIUM_BPS = 9n; // 0.09%
      const expectedReturn = BigInt(priceRoutes.priceRouteSwap2.destAmount);
      
      const simulation = await simulateArbitrageOpportunity(
        {
          expectedOut: BigInt(priceRoutes.priceRouteSwap1.destAmount),
          tokenVolatility: 'high',
          dex: priceRoutes.priceRouteSwap1.exchange || 'generic'
        },
        {
          expectedOut: expectedReturn,
          tokenVolatility: 'high',
          dex: priceRoutes.priceRouteSwap2.exchange || 'generic'
        },
        loanAmountWei,
        FLASHLOAN_PREMIUM_BPS
      );
      
      // Convert profit in token to USD for threshold comparison
      const tokenPriceUSD = parseFloat(priceRoutes.priceRouteSwap1.srcUSD) / parseFloat(ethers.formatUnits(loanAmountWei, getTokenDecimals(srcToken)));
      const simulatedProfitUSD = parseFloat(ethers.formatUnits(simulation.profit, getTokenDecimals(srcToken))) * tokenPriceUSD;
      
      console.log(`Simulated profit check: $${simulatedProfitUSD.toFixed(2)} vs threshold $${MIN_PROFIT_THRESHOLD_USD}`);
      
      // Only consider profitable if simulation also indicates profitability above threshold
      return simulatedProfitUSD >= MIN_PROFIT_THRESHOLD_USD && simulation.executionRecommendation !== 'SKIP';
      
    } catch (error) {
      console.error(`⚠️ Profit check failed for ${srcToken} -> ${destToken} -> ${returnToken}:`, error.message);
      return false;
    }
  }

// Monitor function with dynamic token updates
async function monitor() {
    try {
        // Initialize token registry and analytics
        const tokenRegistry = new TokenRegistry(signer);
        const analytics = new TokenAnalytics();
        const mempoolAnalyzer = new MempoolAnalyzer(provider);
        await mempoolAnalyzer.start();

        // Initial loading of token pairs
        let activePairs = await tokenRegistry.loadTokenPairs();
        console.log('🔄 Initial token pairs loaded:', activePairs.pairs.length);

        while (true) {
            // Get prioritized pairs based on performance
            const pairsByPriority = activePairs.pairs
                .sort((a, b) => {
                    const scoreA = (a.performanceMetrics.successRate * a.performanceMetrics.averageProfit);
                    const scoreB = (b.performanceMetrics.successRate * b.performanceMetrics.averageProfit);
                    return scoreB - scoreA;
                });

            // Process top pairs
            for (const pair of pairsByPriority) {
                const srcToken = await tokenRegistry.getTokenContract(pair.base);
                const destToken = await tokenRegistry.getTokenContract(pair.quote);
                
                console.log(`\n🔍 Checking ${pair.base} → ${pair.quote}`);
                
                try {
                    // Check for profitable opportunity
                    const isProfitable = await isProfitableOpportunity(
                        srcToken.address,
                        destToken.address,
                        srcToken.address,
                        pair.optimalSize.toString()
                    );

                    if (isProfitable) {
                        console.log(`💰 Found opportunity for ${pair.base}-${pair.quote}`);
                        const result = await executeFlashArbitrage(
                            srcToken.address,
                            destToken.address,
                            srcToken.address,
                            pair.optimalSize.toString()
                        );

                        // Update performance metrics
                        if (result) {
                            await tokenRegistry.updatePairPerformance(
                                `${pair.base}-${pair.quote}`,
                                {
                                    timestamp: new Date(),
                                    volumeUSD: result.volumeUSD || 0,
                                    profitUSD: result.profitUSD || 0,
                                    success: result.success
                                }
                            );
                        }
                    }
                } catch (error) {
                    console.error(`Error processing pair ${pair.base}-${pair.quote}:`, error.message);
                }

                await delay(1000); // Prevent rate limiting
            }

            // Check watchlist pairs periodically
            if (Date.now() - lastWatchlistCheck > WATCHLIST_CHECK_INTERVAL) {
                for (const pair of activePairs.watchlist) {
                    try {
                        const result = await checkWatchlistPair(pair, tokenRegistry);
                        if (result.promote) {
                            console.log(`🔥 Promoting ${pair.base}-${pair.quote} from watchlist to active pairs`);
                            // Will be added to active pairs in next top_pairs.json update
                        }
                    } catch (error) {
                        console.error(`Error checking watchlist pair ${pair.base}-${pair.quote}:`, error.message);
                    }
                }
                lastWatchlistCheck = Date.now();
            }

            // Reload token pairs periodically to pick up changes
            const pairsAge = Date.now() - new Date(activePairs.lastUpdated).getTime();
            if (pairsAge > activePairs.updateInterval * 1000) {
                console.log('📊 Reloading token pairs configuration...');
                activePairs = await tokenRegistry.loadTokenPairs();
            }

            await delay(CHECK_INTERVAL);
        }
    } catch (error) {
        console.error('❌ Monitor error:', error);
        throw error;
    }
}

// Helper function to evaluate watchlist pairs
async function checkWatchlistPair(pair, tokenRegistry) {
    const srcToken = await tokenRegistry.getTokenContract(pair.base);
    const destToken = await tokenRegistry.getTokenContract(pair.quote);
    
    const testAmount = '0.1'; // Small test amount
    const isProfitable = await isProfitableOpportunity(
        srcToken.address,
        destToken.address,
        srcToken.address,
        testAmount
    );

    // Update pair metrics
    pair.dataPoints++;
    if (isProfitable) {
        pair.preliminaryMetrics.successCount = (pair.preliminaryMetrics.successCount || 0) + 1;
    }

    // Calculate success rate
    const successRate = pair.preliminaryMetrics.successCount / pair.dataPoints;

    // Determine if pair should be promoted
    return {
        promote: pair.dataPoints >= 10 && successRate >= 0.6,
        successRate,
        dataPoints: pair.dataPoints
    };
}

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

async function main() {
    const setupOk = await verifySetup();
    if (!setupOk) {
        console.error('Exiting due to setup verification failure');
        process.exit(1);
    }

    console.log('🔄 Initializing analytics with historical data...');
    const tokenPairs = await initializeAnalytics();
    
    // Start monitoring with optimized token pairs
    console.log('🚀 Starting arbitrage monitor with data-driven parameters...');
    await monitor(tokenPairs);
}

main().catch(console.error);

class MempoolAnalyzer {
    constructor(provider) {
        this.provider = provider;
        this.pendingTxs = new Map();
        this.gasPriceHistory = [];
        this.lastBaseFee = null;
        this.volatilityWindow = 10; // blocks
    }

    async start() {
        // Subscribe to pending transactions
        this.provider.on('pending', async (txHash) => {
            try {
                const tx = await this.provider.getTransaction(txHash);
                if (tx) {
                    this.pendingTxs.set(txHash, {
                        hash: txHash,
                        to: tx.to,
                        gasPrice: tx.maxFeePerGas || tx.gasPrice,
                        data: tx.data,
                        timestamp: Date.now()
                    });
                }
            } catch (error) {
                console.error('Error processing pending transaction:', error);
            }
        });

        // Subscribe to new blocks for gas price tracking
        this.provider.on('block', async (blockNumber) => {
            try {
                const block = await this.provider.getBlock(blockNumber);
                if (block && block.baseFeePerGas) {
                    this.lastBaseFee = block.baseFeePerGas;
                    this.gasPriceHistory.push({
                        blockNumber,
                        baseFee: block.baseFeePerGas,
                        timestamp: Date.now()
                    });
                    
                    // Keep only recent history
                    if (this.gasPriceHistory.length > this.volatilityWindow) {
                        this.gasPriceHistory.shift();
                    }
                }
            } catch (error) {
                console.error('Error processing new block:', error);
            }
        });
    }

    stop() {
        this.provider.removeAllListeners('pending');
        this.provider.removeAllListeners('block');
    }

    // Calculate optimal gas price based on mempool and profit margin
    async calculateOptimalGas(expectedProfitUSD, urgencyLevel = 'normal') {
        const currentFeeData = await this.provider.getFeeData();
        const baseFee = currentFeeData.lastBaseFeePerGas || currentFeeData.gasPrice;
        
        // Calculate gas price volatility
        const volatility = this.calculateGasVolatility();
        
        // Urgency multipliers
        const urgencyMultipliers = {
            low: 1.1,
            normal: 1.3,
            high: 1.5,
            urgent: 2.0
        };
        
        // Calculate priority fee based on mempool congestion
        const congestionMultiplier = this.calculateCongestionMultiplier();
        const baseMultiplier = urgencyMultipliers[urgencyLevel] || urgencyMultipliers.normal;
        const finalMultiplier = baseMultiplier * congestionMultiplier;
        
        // Calculate maximum viable gas price based on expected profit
        const maxViableGasPrice = this.calculateMaxViableGasPrice(expectedProfitUSD);
        
        // Calculate suggested gas price
        let suggestedGasPrice = baseFee * BigInt(Math.floor(finalMultiplier * 100)) / 100n;
        
        // Ensure we don't exceed maximum viable gas price
        suggestedGasPrice = suggestedGasPrice > maxViableGasPrice ? maxViableGasPrice : suggestedGasPrice;
        
        return {
            maxFeePerGas: suggestedGasPrice,
            maxPriorityFeePerGas: currentFeeData.maxPriorityFeePerGas || 
                                 (suggestedGasPrice - baseFee) / 2n,
            baseFee,
            volatility,
            congestionLevel: congestionMultiplier
        };
    }

    calculateGasVolatility() {
        if (this.gasPriceHistory.length < 2) return 0;
        
        const fees = this.gasPriceHistory.map(h => Number(h.baseFee));
        const mean = fees.reduce((a, b) => a + b, 0) / fees.length;
        const variance = fees.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / fees.length;
        return Math.sqrt(variance) / mean; // Coefficient of variation
    }

    calculateCongestionMultiplier() {
        const CONGESTION_THRESHOLD = 50; // Number of pending transactions to consider high congestion
        const recentTxs = Array.from(this.pendingTxs.values())
            .filter(tx => Date.now() - tx.timestamp < 60000); // Last minute
        
        const congestionLevel = recentTxs.length / CONGESTION_THRESHOLD;
        return Math.min(Math.max(1, 1 + (congestionLevel * 0.5)), 2); // 1.0-2.0x multiplier
    }

    calculateMaxViableGasPrice(expectedProfitUSD) {
        const GAS_LIMIT = 5000000n; // From your existing configuration
        const ETH_PRICE_USD = 4000; // This should be dynamically updated in production
        
        // Convert expected profit to ETH
        const maxProfitInETH = BigInt(Math.floor((expectedProfitUSD / ETH_PRICE_USD) * 1e18));
        
        // Calculate maximum gas price that maintains profitability
        // Leave 20% profit margin
        return (maxProfitInETH * 80n / 100n) / GAS_LIMIT;
    }

    shouldExecute(token, amount) {
        // Check for competing transactions that might affect our trade
        const competingTxs = Array.from(this.pendingTxs.values())
            .filter(tx => {
                const isRecent = Date.now() - tx.timestamp < 30000; // Last 30 seconds
                const involvesToken = tx.data.includes(token.toLowerCase().slice(2));
                return isRecent && involvesToken;
            });

        if (competingTxs.length > 5) {
            console.log(`High competition detected for ${token}, delaying execution`);
            return false;
        }

        return true;
    }
}

class GasOptimizer {
    constructor(provider) {
        this.provider = provider;
        this.blockHistory = [];
        this.maxBlockHistory = 20;
        this.gasEstimates = new Map();
    }

    async initialize() {
        const currentBlock = await this.provider.getBlock('latest');
        for (let i = 0; i < this.maxBlockHistory; i++) {
            const block = await this.provider.getBlock(currentBlock.number - i);
            if (block) {
                this.blockHistory.push({
                    number: block.number,
                    baseFeePerGas: block.baseFeePerGas,
                    gasUsed: block.gasUsed,
                    gasLimit: block.gasLimit,
                    timestamp: block.timestamp
                });
            }
        }
    }

    async predictNextBaseFee() {
        if (this.blockHistory.length < 2) return null;

        const latestBlock = this.blockHistory[0];
        const targetGasUsed = latestBlock.gasLimit / 2n;
        const gasUsedDelta = latestBlock.gasUsed - targetGasUsed;
        
        // EIP-1559 formula
        const currentBaseFee = latestBlock.baseFeePerGas;
        const gasUsedRatio = Number(latestBlock.gasUsed) / Number(latestBlock.gasLimit);
        const maxBaseFeeChange = currentBaseFee / 8n; // Maximum 12.5% change per block
        
        let nextBaseFee;
        if (gasUsedRatio > 0.5) {
            // Increase base fee
            nextBaseFee = currentBaseFee + maxBaseFeeChange;
        } else {
            // Decrease base fee
            nextBaseFee = currentBaseFee - maxBaseFeeChange;
        }
        
        return nextBaseFee;
    }

    async calculateOptimalGasFees(urgency = 'normal') {
        const nextBaseFee = await this.predictNextBaseFee();
        if (!nextBaseFee) return null;

        const urgencyMultipliers = {
            low: 1.05,
            normal: 1.1,
            high: 1.2,
            urgent: 1.5
        };

        const multiplier = urgencyMultipliers[urgency] || urgencyMultipliers.normal;
        const maxFeePerGas = nextBaseFee * BigInt(Math.floor(multiplier * 100)) / 100n;
        
        // Calculate priority fee based on recent successful transactions
        const priorityFeeStats = this.analyzePriorityFees();
        const maxPriorityFeePerGas = this.calculatePriorityFee(priorityFeeStats, urgency);

        return {
            maxFeePerGas,
            maxPriorityFeePerGas,
            estimatedNextBaseFee: nextBaseFee,
            confidence: this.calculateConfidence(priorityFeeStats)
        };
    }

    analyzePriorityFees() {
        // Analyze recent blocks for priority fee patterns
        const priorityFees = this.blockHistory
            .flatMap(block => Array.from(this.gasEstimates.values())
                .filter(tx => tx.blockNumber === block.number)
                .map(tx => tx.priorityFeePerGas));

        if (priorityFees.length === 0) return null;

        const sorted = priorityFees.sort((a, b) => Number(a - b));
        return {
            min: sorted[0],
            max: sorted[sorted.length - 1],
            median: sorted[Math.floor(sorted.length / 2)],
            p75: sorted[Math.floor(sorted.length * 0.75)]
        };
    }

    calculatePriorityFee(stats, urgency) {
        if (!stats) return 1500000000n; // Default 1.5 gwei if no data

        const basePriorityFee = stats.median;
        const urgencyMultipliers = {
            low: 1.0,
            normal: 1.2,
            high: 1.5,
            urgent: 2.0
        };

        return basePriorityFee * BigInt(Math.floor(urgencyMultipliers[urgency] * 100)) / 100n;
    }

    calculateConfidence(stats) {
        if (!stats) return 0.5;
        
        const range = Number(stats.max - stats.min);
        const median = Number(stats.median);
        
        // Lower range relative to median indicates more confidence
        const volatility = range / median;
        return Math.max(0.1, Math.min(0.9, 1 - volatility));
    }

    async updateBlockHistory(blockNumber) {
        const block = await this.provider.getBlock(blockNumber);
        if (block) {
            this.blockHistory.unshift({
                number: block.number,
                baseFeePerGas: block.baseFeePerGas,
                gasUsed: block.gasUsed,
                gasLimit: block.gasLimit,
                timestamp: block.timestamp
            });

            if (this.blockHistory.length > this.maxBlockHistory) {
                this.blockHistory.pop();
            }
        }
    }

    recordTransaction(txHash, gasUsed, priorityFeePerGas, blockNumber) {
        this.gasEstimates.set(txHash, {
            gasUsed,
            priorityFeePerGas,
            blockNumber,
            timestamp: Date.now()
        });

        // Clean up old estimates
        const ONE_HOUR = 3600000;
        for (const [hash, data] of this.gasEstimates.entries()) {
            if (Date.now() - data.timestamp > ONE_HOUR) {
                this.gasEstimates.delete(hash);
            }
        }
    }
}

class TokenAnalytics {
    constructor() {
        this.trades = [];
        this.platformStats = new Map();
        this.tokenPairStats = new Map();
        this.pairProfitability = new Map();
    }

    addTrade(trade) {
        this.trades.push(trade);
        this.updatePlatformStats(trade);
        this.updateTokenPairStats(trade);
        this.updatePairProfitability(trade);
    }

    updatePlatformStats(trade) {
        if (!this.platformStats.has(trade.platform)) {
            this.platformStats.set(trade.platform, {
                totalProfit: 0,
                tradeCount: 0,
                avgProfit: 0,
                successRate: 0
            });
        }
        const stats = this.platformStats.get(trade.platform);
        stats.totalProfit += trade.profitUSD;
        stats.tradeCount++;
        stats.avgProfit = stats.totalProfit / stats.tradeCount;
    }

    updateTokenPairStats(trade) {
        const pairKey = `${trade.symbolIn}-${trade.symbolOut}`;
        if (!this.tokenPairStats.has(pairKey)) {
            this.tokenPairStats.set(pairKey, {
                totalProfit: 0,
                tradeCount: 0,
                avgProfit: 0,
                totalVolume: 0,
                successCount: 0
            });
        }
        const stats = this.tokenPairStats.get(pairKey);
        stats.totalProfit += trade.profitUSD;
        stats.tradeCount++;
        stats.avgProfit = stats.totalProfit / stats.tradeCount;
        stats.totalVolume += trade.amountInUSD;
        if (trade.profitUSD > 0) stats.successCount++;
    }

    updatePairProfitability(trade) {
        const pairKey = `${trade.symbolIn}-${trade.symbolOut}`;
        if (!this.pairProfitability.has(pairKey)) {
            this.pairProfitability.set(pairKey, {
                totalProfit: 0,
                recentProfits: [],
                volatility: 0,
                trend: 0
            });
        }
        const profitData = this.pairProfitability.get(pairKey);
        profitData.totalProfit += trade.profitUSD;
        profitData.recentProfits.push({
            timestamp: new Date(trade.timestamp),
            profit: trade.profitUSD
        });
        
        // Keep only last 20 trades for trend analysis
        if (profitData.recentProfits.length > 20) {
            profitData.recentProfits.shift();
        }
        
        // Calculate volatility and trend
        if (profitData.recentProfits.length > 1) {
            profitData.volatility = this.calculateVolatility(profitData.recentProfits);
            profitData.trend = this.calculateTrend(profitData.recentProfits);
        }
    }

    calculateVolatility(profits) {
        const values = profits.map(p => p.profit);
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length;
        return Math.sqrt(variance);
    }

    calculateTrend(profits) {
        if (profits.length < 2) return 0;
        const recent = profits.slice(-5);
        const oldAvg = profits.slice(0, -5).reduce((a, b) => a + b.profit, 0) / (profits.length - 5);
        const recentAvg = recent.reduce((a, b) => a + b.profit, 0) / recent.length;
        return recentAvg - oldAvg;
    }

    getBestPairs() {
        return Array.from(this.tokenPairStats.entries())
            .sort((a, b) => b[1].avgProfit - a[1].avgProfit)
            .slice(0, 5);
    }

    getBestPlatforms() {
        return Array.from(this.platformStats.entries())
            .sort((a, b) => b[1].avgProfit - a[1].avgProfit);
    }

    getOptimalTradeSize(symbolIn, symbolOut) {
        const pairKey = `${symbolIn}-${symbolOut}`;
        const stats = this.tokenPairStats.get(pairKey);
        if (!stats) return null;
        
        return {
            optimal: stats.totalVolume / stats.tradeCount,
            minProfit: stats.totalProfit / stats.tradeCount * 0.5, // 50% of average as minimum
            successRate: stats.successCount / stats.tradeCount
        };
    }
}

// Create analytics instance
const analytics = new TokenAnalytics();

// Historical data analysis
async function loadHistoricalTrades() {
    try {
        const fs = require('fs').promises;
        const csv = require('csv-parse/sync');
        
        const data = await fs.readFile('data.csv', 'utf-8');
        const records = csv.parse(data, {
            columns: true,
            skip_empty_lines: true
        });

        // Process historical trades
        records.forEach(record => {
            analytics.addTrade({
                timestamp: new Date(record.BLOCK_TIMESTAMP),
                symbolIn: record.SYMBOL_IN,
                symbolOut: record.SYMBOL_OUT,
                platform: record.PLATFORM,
                amountInUSD: parseFloat(record.AMOUNT_IN_USD),
                amountOutUSD: parseFloat(record.AMOUNT_OUT_USD),
                profitUSD: parseFloat(record.PROFIT_USD)
            });
        });

        // Calculate token-specific thresholds
        const thresholds = new Map();
        const pairs = analytics.getBestPairs();
        pairs.forEach(([pair, stats]) => {
            const [symbolIn, symbolOut] = pair.split('-');
            thresholds.set(symbolOut, {
                minProfit: Math.max(50, stats.avgProfit * 0.3), // At least 30% of average profit
                optimalSize: stats.totalVolume / stats.tradeCount,
                successRate: stats.successCount / stats.tradeCount
            });
        });

        return thresholds;
    } catch (error) {
        console.error('Error loading historical trades:', error);
        return new Map();
    }
}

// Initialize analytics with historical data
async function initializeAnalytics() {
    console.log('Loading token pair configurations and historical trade data...');
    const thresholds = await loadHistoricalTrades();
    
    // Load and parse the enhanced token pairs data
    const topPairs = JSON.parse(fs.readFileSync('./top_pairs.json', 'utf-8'));
    
    // Convert token pairs data to the format expected by monitor
    const TOKEN_PAIRS = topPairs.map(pair => ({
        srcToken: TOKENS[pair.base].address,
        destToken: TOKENS[pair.quote].address,
        expectedProfitMin: Math.max(
            pair.expectedProfitMin,
            thresholds.get(pair.quote)?.minProfit || 0.3
        ),
        optimalSize: ethers.parseEther(
            thresholds.get(pair.quote)?.optimalSize?.toString() || pair.optimalSize
        ),
        volatility: pair.historicalVolatility,
        liquidityScore: pair.liquidityScore,
        timeWindow: pair.timeWindow
    }));

    console.log('Token pair configurations loaded:');
    TOKEN_PAIRS.forEach(pair => {
        const quoteSymbol = Object.entries(TOKENS).find(
            ([_, token]) => token.address.toLowerCase() === pair.destToken.toLowerCase()
        )?.[0];
        
        console.log(`${pair.srcToken.slice(0, 8)}...→${pair.destToken.slice(0, 8)}... (${quoteSymbol}):
            Min Profit: $${pair.expectedProfitMin.toFixed(2)}
            Optimal Size: ${ethers.formatEther(pair.optimalSize)} WETH
            Volatility: ${pair.volatility}
            Liquidity Score: ${pair.liquidityScore}`);
    });

    return TOKEN_PAIRS;
}

// ...existing code...
