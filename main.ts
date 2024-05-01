import {
  createPublicClient,
  formatUnits,
  getContract,
  http,
  zeroAddress,
} from "viem";
import { bsc, mainnet, polygon } from "viem/chains";
import { CoinGeckoClient, type TokenPriceResponse } from "coingecko-api-v3";
import { parseArgs, Spinner } from "@std/cli";
import type { Args } from "@std/cli";

import { lpStakingAbi } from "./lpStakingAbi.ts";
import { lpPoolAbi } from "./lpPoolAbi.ts";
import { erc20Abi } from "./erc20Abi.ts";

type ContractAddresses = {
  LP_STAKING: `0x${string}`;
  USDC: `0x${string}`;
  USDT: `0x${string}`;
};

const CONTRACT_ADDRESSES_MAP: Record<string, ContractAddresses> = {
  "mainnet": {
    LP_STAKING: "0xB0D502E938ed5f4df2E681fE6E419ff29631d62b",
    USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  },
  "bsc": {
    LP_STAKING: "0x3052A0F6ab15b4AE1df39962d5DdEFacA86DaB47",
    USDC: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    USDT: "0x55d398326f99059fF775485246999027B3197955",
  },
  "polygon": {
    LP_STAKING: "0x8731d54E9D02c286767d56ac03e8037C07e01e98",
    USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  },
};

const STG_DECIMALS = 18n;
const STG_TICKER = "STG";

function humanizeMoneyValue(value: number): string {
  const formatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  });

  return formatter.format(value);
}
function parseArguments(args: string[]): Args {
  // All boolean arguments
  const booleanArgs = [
    "help",
    "verbose",
  ];

  // All string arguments
  const stringArgs = [
    "chain",
    "address",
  ];

  // And a list of aliases
  const alias = {
    "help": "h",
    "chain": "c",
    "address": "a",
  };
  const defaultArgs = {
    chain: "mainnet",
  };

  return parseArgs(args, {
    alias,
    string: stringArgs,
    boolean: booleanArgs,
    default: defaultArgs,
    stopEarly: false,
    "--": true,
  });
}

function printHelp() {
  console.log("Usage: deno run main.ts [options]");
  console.log(`
Options:
  --help, -h: Print this help message
  --chain, -c: Chain to connect to (mainnet, bsc, polygon)
  --address, -a: Address to query
  --verbose, -v: Enable verbose mode
  `);
}

if (import.meta.main) {
  const args = parseArguments(Deno.args);
  if (args.help) {
    printHelp();
    Deno.exit(0);
  }
  if (!args.address) {
    console.error("Please provide an address with the --address flag");
    Deno.exit(1);
  }
  let chain = undefined;
  switch (args.chain) {
    case "mainnet":
      chain = mainnet;
      break;
    case "bsc":
      chain = bsc;
      break;
    case "polygon":
      chain = polygon;
      break;
    default:
      chain = mainnet;
  }
  const client = createPublicClient({
    chain,
    transport: http(),
    batch: {
      multicall: true,
    },
  });
  console.log(`Connected to Chain: ${args.chain}`);
  const contractAddress = CONTRACT_ADDRESSES_MAP[args.chain].LP_STAKING;
  console.log(`Stargate LPStaking Contract Address: ${contractAddress}`);
  let spinner = new Spinner({ message: "calculating avg block time..." });
  spinner.start();
  // To calculate avg block time, we query the most recent block and the block 100 blocks before it
  // and calculate the average time between the two blocks.
  const latestBlock = await client.getBlock();
  const block = await client.getBlock({
    blockNumber: latestBlock.number - 100n,
  });
  const avgBlockTime = (latestBlock.timestamp - block.timestamp) / 100n;
  spinner.stop();
  console.log(`Average Block Time: ${avgBlockTime}s`);

  const blocksPerHour = 3600n / avgBlockTime;
  const blocksPerDay = blocksPerHour * 24n;
  const blocksPerWeek = blocksPerDay * 7n;
  const blocksPerMonth = blocksPerWeek * 4n;
  const blocksPerYear = blocksPerMonth * 12n;

  const cg = new CoinGeckoClient({
    timeout: 5_000,
    autoRetry: true,
  }, Deno.env.get("COINGECKO_API_KEY"));
  await cg.ping();
  const lpStaking = getContract({
    address: contractAddress,
    abi: lpStakingAbi,
    client,
  });

  const stgPerBlock = await lpStaking.read.stargatePerBlock();
  console.log(
    `STG Per Block: ${
      formatUnits(stgPerBlock, Number(STG_DECIMALS))
    } ${STG_TICKER}`,
  );
  // Fetch pools.
  spinner = new Spinner({ message: "Fetching Pools and user postions..." });
  spinner.start();
  const stargateTokenAddress = await lpStaking.read.stargate();
  const poolLength = await lpStaking.read.poolLength();
  const totalAllocPoint = await lpStaking.read.totalAllocPoint();
  const pools = await Promise.all(
    [...Array(Number(poolLength)).keys()].map(async (pid) =>
      [
        pid,
        await lpStaking.read.poolInfo([BigInt(pid)]),
        await lpStaking.read.userInfo([BigInt(pid), args.address]),
      ] as const
    ),
  );
  const activePools = pools.filter(([_, pool, userInfo]) =>
    // filter out pools with no allocPoint
    pool[1] > 0 &&
    // filter out pools without user staked
    userInfo[0] > 0
  ).map((
    [pid, pool, userInfo],
  ) => ({
    pid: BigInt(pid),
    contract: getContract({
      address: pool[0],
      abi: lpPoolAbi,
      client,
    }),
    allocPoint: pool[1],
    lastRewardBlock: pool[2],
    accStargatePerShare: pool[3],
    userStaked: userInfo[0],
    rewardDebt: userInfo[1],
  }));

  const activePoolsWithNames = await Promise.all(
    activePools.map(async (pool) => {
      const lpToken = await pool.contract.read.name();
      const token = await pool.contract.read.token();
      const decimals = await pool.contract.read.decimals();
      const erc20 = getContract({
        address: token,
        abi: erc20Abi,
        client,
      });
      const underlyingToken = await erc20.read.name();
      const lpSupply = await lpStaking.read.lpBalances([pool.pid]);
      const staked = Number(lpSupply);
      const stgPerBlockF = parseFloat(
        formatUnits(stgPerBlock, Number(STG_DECIMALS)),
      );
      const rewardPerBlock = stgPerBlockF *
        (Number(pool.allocPoint) / Number(totalAllocPoint));

      const rewardPerDay = rewardPerBlock * Number(blocksPerDay);
      const rewardPerWeek = rewardPerBlock * Number(blocksPerWeek);
      const rewardPerMonth = rewardPerBlock * Number(blocksPerMonth);
      const rewardPerYear = rewardPerBlock * Number(blocksPerYear);

      const stakedTokens = Number(lpSupply / 10n ** decimals);
      const weeklyAPY = rewardPerWeek * 100 / stakedTokens;
      const dailyAPY = weeklyAPY / 7.0;
      const monthlyAPY = weeklyAPY * 4.0;
      const yearlyAPY = weeklyAPY * 52.0;

      const userStakedPct = (Number(pool.userStaked) * 100) / staked;
      const userDailyReward = (rewardPerDay * userStakedPct) / 100;
      const userWeeklyReward = (rewardPerWeek * userStakedPct) / 100;
      const userMonthlyReward = (rewardPerMonth * userStakedPct) / 100;
      const userYearlyReward = (rewardPerYear * userStakedPct) / 100;

      const pendingStg = await lpStaking.read.pendingStargate([
        pool.pid,
        args.address,
      ]);
      return {
        ...pool,
        decimals,
        staked: lpSupply,
        lpToken,
        token,
        erc20,
        pendingStg,
        underlyingToken,
        rewardPerBlock,
        rewardPerDay,
        rewardPerWeek,
        rewardPerMonth,
        rewardPerYear,
        dailyAPY,
        weeklyAPY,
        monthlyAPY,
        yearlyAPY,
        userStakedPct,
        userDailyReward,
        userWeeklyReward,
        userMonthlyReward,
        userYearlyReward,
      };
    }),
  );

  spinner.stop();
  // fetch token prices for each pool
  spinner = new Spinner({ message: "Fetching Token Prices..." });
  spinner.start();
  const tokens = activePoolsWithNames.map((pool) => pool.token);
  // exclude stablecoins from token prices.
  const stableCoins = [
    CONTRACT_ADDRESSES_MAP[args.chain].USDC,
    CONTRACT_ADDRESSES_MAP[args.chain].USDT,
  ];
  const filteredTokens = tokens.filter((token) =>
    !stableCoins.includes(token as `0x${string}`)
  );
  let tokenPrices: TokenPriceResponse;
  if (filteredTokens.length === 0) {
    tokenPrices = {};
  } else {
    tokenPrices = await cg.simpleTokenPrice({
      id: "ethereum",
      contract_addresses: filteredTokens.length > 1
        ? filteredTokens.join(",")
        : filteredTokens[0],
      vs_currencies: "usd",
    });
  }
  // Add stablecoins to token prices with a price of 1.
  tokenPrices[CONTRACT_ADDRESSES_MAP[args.chain].USDC] = {
    usd: 1.0,
    ticker: "USDC",
  };
  tokenPrices[CONTRACT_ADDRESSES_MAP[args.chain].USDT] = {
    usd: 1.0,
    ticker: "USDT",
  };
  // fetch STG, native token of the platform.
  let nativeToken = "ethereum";
  let nativeTokenTicker = "ETH";
  switch (args.chain) {
    case "mainnet":
      nativeToken = "ethereum";
      nativeTokenTicker = "ETH";
      break;
    case "bsc":
      nativeToken = "binancecoin";
      nativeTokenTicker = "BNB";
      break;
    case "polygon":
      nativeToken = "matic-network";
      nativeTokenTicker = "MATIC";
      break;
    default:
      nativeToken = "ethereum";
      nativeTokenTicker = "ETH";
  }
  const pricesResponse = await cg.simplePrice({
    ids: ["stargate-finance", nativeToken].join(","),
    vs_currencies: "usd",
  });
  tokenPrices[stargateTokenAddress] = {
    ...pricesResponse["stargate-finance"],
    ticker: STG_TICKER,
  };
  tokenPrices[zeroAddress] = {
    ...pricesResponse[nativeToken],
    ticker: nativeTokenTicker,
  };
  spinner.stop();

  console.log("Token Prices:");
  Object.entries(tokenPrices).forEach(([token, price]) => {
    console.log(
      `|- ${token} (${price.ticker}): ${humanizeMoneyValue(price.usd)}`,
    );
  });

  console.log(`Number of Active Pools: ${activePoolsWithNames.length}`);
  console.log("Pools:");
  activePoolsWithNames.forEach((pool, index) => {
    console.log(`|- Pool ${index}:`);
    console.log(`|-- LP Asset: ${pool.lpToken}`);
    console.log(`|-- Underlying Asset: ${pool.underlyingToken}`);
    console.log(`|-- LP Token Address: ${pool.contract.address}`);
    console.log(`|-- Token Address: ${pool.token}`);
    if (args.verbose) {
      console.log(
        `|-- Staked: ${
          formatUnits(pool.staked, Number(pool.decimals))
        } ${pool.lpToken}`,
      );
    }
    console.log(
      `|-- User Staked: ${
        formatUnits(pool.userStaked, Number(pool.decimals))
      } ${pool.lpToken}`,
    );
    console.log(
      `|-- Pending STG: ${
        formatUnits(pool.pendingStg, Number(STG_DECIMALS))
      } ${STG_TICKER}`,
    );
    if (args.verbose) {
      console.log(
        `|-- Reward Per Block: ${pool.rewardPerBlock.toFixed(2)} ${STG_TICKER}`,
      );
      console.log(
        `|-- Reward Per Day: ${pool.rewardPerDay.toFixed(2)} ${STG_TICKER}`,
      );
      console.log(
        `|-- Reward Per Week: ${pool.rewardPerWeek.toFixed(2)} ${STG_TICKER}`,
      );
      console.log(
        `|-- Reward Per Month: ${pool.rewardPerMonth.toFixed(2)} ${STG_TICKER}`,
      );
      console.log(
        `|-- Reward Per Year: ${pool.rewardPerYear.toFixed(2)} ${STG_TICKER}`,
      );
      console.log(`|-- Weekly APY: ${pool.weeklyAPY.toFixed(4)}%`);
      console.log(`|-- Monthly APY: ${pool.monthlyAPY.toFixed(2)}%`);
      console.log(`|-- Yearly APY: ${pool.yearlyAPY.toFixed(2)}%`);
      console.log(
        `|-- User Staked Percentage: ${pool.userStakedPct.toFixed(4)}%`,
      );
    }
    console.log(
      `|-- User Daily Reward: ${pool.userDailyReward.toFixed(4)} ${STG_TICKER}`,
    );
    console.log(
      `|-- User Weekly Reward: ${
        pool.userWeeklyReward.toFixed(2)
      } ${STG_TICKER}`,
    );
    console.log(
      `|-- User Monthly Reward: ${
        pool.userMonthlyReward.toFixed(2)
      } ${STG_TICKER}`,
    );
    console.log(
      `|-- User Yearly Reward: ${pool.userYearlyReward.toFixed()} ${STG_TICKER}`,
    );
    // in USD.
    const lpTokenPrice = tokenPrices[pool.token].usd;
    const stgPrice = tokenPrices[stargateTokenAddress].usd;
    const lpValue = lpTokenPrice *
      parseFloat(formatUnits(pool.staked, Number(pool.decimals)));
    const pendingStgValue = stgPrice *
      parseFloat(formatUnits(pool.pendingStg, Number(STG_DECIMALS)));
    console.log(
      `|-- Pending STG Value: ${humanizeMoneyValue(pendingStgValue)}`,
    );
    // Yield in USD
    const dailyYield = pool.userDailyReward * stgPrice;
    const weeklyYield = pool.userWeeklyReward * stgPrice;
    const monthlyYield = pool.userMonthlyReward * stgPrice;
    const yearlyYield = pool.userYearlyReward * stgPrice;
    if (args.verbose) {
      console.log(`|-- LP Value: ${humanizeMoneyValue(lpValue)}`);
      console.log(`|-- Daily Yield: ${humanizeMoneyValue(dailyYield)}`);
      console.log(`|-- Weekly Yield: ${humanizeMoneyValue(weeklyYield)}`);
      console.log(`|-- Monthly Yield: ${humanizeMoneyValue(monthlyYield)}`);
      console.log(`|-- Yearly Yield: ${humanizeMoneyValue(yearlyYield)}`);
    }
    const userdailyYield = pool.userDailyReward * stgPrice;
    const userweeklyYield = pool.userWeeklyReward * stgPrice;
    const usermonthlyYield = pool.userMonthlyReward * stgPrice;
    const useryearlyYield = pool.userYearlyReward * stgPrice;
    console.log(`|-- User Daily Yield: ${humanizeMoneyValue(userdailyYield)}`);
    console.log(
      `|-- User Weekly Yield: ${humanizeMoneyValue(userweeklyYield)}`,
    );
    console.log(
      `|-- User Monthly Yield: ${humanizeMoneyValue(usermonthlyYield)}`,
    );
    console.log(
      `|-- User Yearly Yield: ${humanizeMoneyValue(useryearlyYield)}`,
    );
    console.log("|");
  });
}
