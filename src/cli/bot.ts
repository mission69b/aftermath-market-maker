#!/usr/bin/env node
import { program } from "commander";
import { config } from "dotenv";
import { MarketMaker } from "../bots/mm/index.js";
import { type ExchangeName, getSupportedExchanges } from "../exchanges/index.js";
import type { PriceSource } from "../pricing/fair-price.js";
import { logger } from "../utils/logger.js";

// Load environment variables
config();

const SUPPORTED_PRICE_SOURCES: PriceSource[] = ["binance", "hyperliquid"];

program
  .name("mm-bot")
  .description("Multi-exchange perpetuals market maker bot")
  .version("1.0.0")
  .requiredOption(
    "-e, --exchange <exchange>",
    `Exchange to trade on (${getSupportedExchanges().join(", ")})`,
    process.env.EXCHANGE
  )
  .requiredOption("-s, --symbol <symbol>", "Trading symbol (e.g., BTC, ETH)", process.env.SYMBOL)
  .option(
    "-p, --price-source <source>",
    `Price oracle source (${SUPPORTED_PRICE_SOURCES.join(", ")})`,
    process.env.PRICE_SOURCE || "binance"
  )
  .option("--spread-bps <bps>", "Spread in basis points", process.env.SPREAD_BPS)
  .option("--order-size <usd>", "Order size in USD", process.env.ORDER_SIZE_USD)
  .option("--close-threshold <usd>", "Close mode threshold in USD", process.env.CLOSE_THRESHOLD_USD)
  .option("--max-position <usd>", "Maximum position in USD", process.env.MAX_POSITION_USD)
  .option("--warmup <seconds>", "Warmup period in seconds", process.env.WARMUP_SECONDS)
  .parse(process.argv);

const options = program.opts();

// Validate exchange
const exchange = options.exchange?.toLowerCase() as ExchangeName;
if (!getSupportedExchanges().includes(exchange)) {
  console.error(`Invalid exchange: ${options.exchange}`);
  console.error(`Supported exchanges: ${getSupportedExchanges().join(", ")}`);
  process.exit(1);
}

// Validate price source
const priceSource = options.priceSource?.toLowerCase() as PriceSource;
if (!SUPPORTED_PRICE_SOURCES.includes(priceSource)) {
  console.error(`Invalid price source: ${options.priceSource}`);
  console.error(`Supported sources: ${SUPPORTED_PRICE_SOURCES.join(", ")}`);
  process.exit(1);
}

// Build config overrides from CLI options
const configOverrides: Record<string, unknown> = {};
configOverrides.priceSource = priceSource;
if (options.spreadBps) configOverrides.spreadBps = Number.parseInt(options.spreadBps, 10);
if (options.orderSize) configOverrides.orderSizeUsd = Number.parseFloat(options.orderSize);
if (options.closeThreshold)
  configOverrides.closeThresholdUsd = Number.parseFloat(options.closeThreshold);
if (options.maxPosition) configOverrides.maxPositionUsd = Number.parseFloat(options.maxPosition);
if (options.warmup) configOverrides.warmupSeconds = Number.parseInt(options.warmup, 10);

// Create and start market maker
const mm = new MarketMaker(exchange, options.symbol, configOverrides);

// Handle shutdown signals
let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Received ${signal}, shutting down...`);

  try {
    await mm.stop();
    logger.info("Shutdown complete");
    process.exit(0);
  } catch (error) {
    logger.error("Error during shutdown:", error);
    process.exit(1);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Start the bot
logger.info(`Starting market maker: ${exchange} ${options.symbol} (price source: ${priceSource})`);

mm.start()
  .then(() => {
    logger.info("Market maker started successfully");

    // Log status periodically
    setInterval(() => {
      const status = mm.getStatus();
      logger.info(
        `Status: ${status.state} | Source: ${status.priceSource} | Fair: $${status.fairPrice?.toFixed(2) || "N/A"} | ` +
          `Position: ${status.position.side} $${status.position.notional.toFixed(2)} | ` +
          `PnL: $${status.position.pnl.toFixed(2)} | ` +
          `Margin: ${(status.marginRatio * 100).toFixed(1)}% | ` +
          `Close Mode: ${status.isCloseMode}`
      );
    }, 10000);
  })
  .catch((error) => {
    logger.error("Failed to start market maker:", error);
    process.exit(1);
  });
