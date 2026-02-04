#!/usr/bin/env node
import { program } from "commander";
import { config } from "dotenv";
import { type ExchangeName, createExchange, getSupportedExchanges } from "../exchanges/index.js";
import { FairPriceCalculator } from "../pricing/fair-price.js";
import type { Orderbook, Position } from "../types.js";
import { logger } from "../utils/logger.js";

// Load environment variables
config();

program
  .name("mm-monitor")
  .description("Monitor market data for perpetuals exchanges")
  .version("1.0.0")
  .requiredOption(
    "-e, --exchange <exchange>",
    `Exchange to use (${getSupportedExchanges().join(", ")})`,
    process.env.EXCHANGE
  )
  .requiredOption("-s, --symbol <symbol>", "Trading symbol (e.g., BTC, ETH)", process.env.SYMBOL)
  .option("--refresh <ms>", "Refresh interval in milliseconds", "1000")
  .parse(process.argv);

const options = program.opts();

// Validate exchange
const exchangeName = options.exchange?.toLowerCase() as ExchangeName;
if (!getSupportedExchanges().includes(exchangeName)) {
  console.error(`Invalid exchange: ${options.exchange}`);
  console.error(`Supported exchanges: ${getSupportedExchanges().join(", ")}`);
  process.exit(1);
}

const refreshMs = Number.parseInt(options.refresh, 10);

// State
let orderbook: Orderbook | null = null;
let positions: Position[] = [];
let fairPrice: number | null = null;

// Clear screen and move cursor to top
function clearScreen(): void {
  process.stdout.write("\x1B[2J\x1B[0f");
}

// Format price with color
function formatPrice(price: number, decimals = 2): string {
  return price.toFixed(decimals);
}

// Format the display
function render(): void {
  clearScreen();

  const now = new Date().toISOString();
  console.log(`=== Market Monitor: ${exchangeName.toUpperCase()} ${options.symbol} ===`);
  console.log(`Time: ${now}`);
  console.log("");

  // Fair price
  console.log("--- Fair Price ---");
  if (fairPrice) {
    console.log(`  Fair Price: $${formatPrice(fairPrice)}`);
  } else {
    console.log("  Waiting for price data...");
  }
  console.log("");

  // Orderbook
  console.log("--- Orderbook ---");
  if (orderbook) {
    const bestBid = orderbook.bids[0];
    const bestAsk = orderbook.asks[0];

    if (bestBid && bestAsk) {
      const spread = bestAsk[0] - bestBid[0];
      const spreadBps = (spread / bestBid[0]) * 10000;

      console.log(`  Best Bid: $${formatPrice(bestBid[0])} x ${bestBid[1].toFixed(4)}`);
      console.log(`  Best Ask: $${formatPrice(bestAsk[0])} x ${bestAsk[1].toFixed(4)}`);
      console.log(`  Spread:   $${formatPrice(spread)} (${spreadBps.toFixed(1)} bps)`);

      if (fairPrice) {
        const bidDiff = ((bestBid[0] - fairPrice) / fairPrice) * 10000;
        const askDiff = ((bestAsk[0] - fairPrice) / fairPrice) * 10000;
        console.log(`  Bid vs Fair: ${bidDiff > 0 ? "+" : ""}${bidDiff.toFixed(1)} bps`);
        console.log(`  Ask vs Fair: ${askDiff > 0 ? "+" : ""}${askDiff.toFixed(1)} bps`);
      }
    } else {
      console.log("  No orderbook data");
    }

    // Show top 5 levels
    console.log("");
    console.log("  Asks:");
    const topAsks = orderbook.asks.slice(0, 5).reverse();
    for (const [price, size] of topAsks) {
      console.log(`    $${formatPrice(price)} x ${size.toFixed(4)}`);
    }

    console.log("  ----");

    console.log("  Bids:");
    const topBids = orderbook.bids.slice(0, 5);
    for (const [price, size] of topBids) {
      console.log(`    $${formatPrice(price)} x ${size.toFixed(4)}`);
    }
  } else {
    console.log("  Waiting for orderbook...");
  }
  console.log("");

  // Positions
  console.log("--- Positions ---");
  if (positions.length > 0) {
    for (const pos of positions) {
      const pnlSign = pos.unrealizedPnl >= 0 ? "+" : "";
      console.log(
        `  ${pos.symbol}: ${pos.side.toUpperCase()} ${pos.size.toFixed(4)} @ $${formatPrice(pos.entryPrice)}`
      );
      console.log(`    PnL: ${pnlSign}$${formatPrice(pos.unrealizedPnl)}`);
      if (pos.liquidationPrice) {
        console.log(`    Liq: $${formatPrice(pos.liquidationPrice)}`);
      }
    }
  } else {
    console.log("  No positions");
  }
  console.log("");

  console.log("Press Ctrl+C to exit");
}

// Main
async function main(): Promise<void> {
  logger.info(`Starting monitor for ${exchangeName} ${options.symbol}`);

  // Create exchange
  const exchange = createExchange(exchangeName);

  // Create fair price calculator
  const fairPriceCalc = new FairPriceCalculator(options.symbol);

  // Connect
  await exchange.connect();
  await fairPriceCalc.connect();

  // Subscribe to orderbook
  await exchange.subscribeOrderbook(options.symbol, (book) => {
    orderbook = book;
  });

  // Subscribe to fair price
  fairPriceCalc.onPriceUpdate((price) => {
    fairPrice = price;
  });

  // Fetch positions periodically
  async function syncPositions(): Promise<void> {
    try {
      positions = await exchange.getPositions();
    } catch (error) {
      logger.error("Failed to fetch positions:", error);
    }
  }

  // Initial sync
  await syncPositions();

  // Start position sync interval
  const positionInterval = setInterval(syncPositions, 5000);

  // Start render interval
  const renderInterval = setInterval(render, refreshMs);

  // Initial render
  render();

  // Handle shutdown
  async function shutdown(): Promise<void> {
    clearInterval(renderInterval);
    clearInterval(positionInterval);

    try {
      await exchange.unsubscribeOrderbook(options.symbol);
      await exchange.disconnect();
      fairPriceCalc.disconnect();
    } catch (error) {
      logger.error("Error during shutdown:", error);
    }

    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  logger.error("Monitor error:", error);
  process.exit(1);
});
