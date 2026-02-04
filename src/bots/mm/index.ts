import { type ExchangeName, type IExchange, createExchange } from "../../exchanges/index.js";
import { FairPriceCalculator } from "../../pricing/fair-price.js";
import type { Market, Order } from "../../types.js";
import { logger } from "../../utils/logger.js";
import { type MarketMakerConfig, mergeConfig, validateConfig } from "./config.js";
import { PositionManager } from "./position.js";
import { Quoter } from "./quoter.js";

/**
 * Market maker state
 */
export type MarketMakerState =
  | "stopped"
  | "connecting"
  | "warming_up"
  | "running"
  | "paused"
  | "error";

/**
 * Market maker status snapshot
 */
export interface MarketMakerStatus {
  state: MarketMakerState;
  exchange: string;
  symbol: string;
  priceSource: string;
  fairPrice: number | null;
  position: {
    side: string;
    size: number;
    notional: number;
    pnl: number;
  };
  orders: {
    bidPrice: number | null;
    bidSize: number | null;
    askPrice: number | null;
    askSize: number | null;
  };
  isCloseMode: boolean;
  marginRatio: number;
  uptime: number;
}

/**
 * Market maker bot
 * Quotes bid/ask around Binance fair price on perpetual exchanges
 */
export class MarketMaker {
  private config: MarketMakerConfig;
  private exchange: IExchange;
  private fairPriceCalc: FairPriceCalculator;
  private quoter: Quoter;
  private positionManager: PositionManager;

  private state: MarketMakerState = "stopped";
  private market: Market | null = null;
  private currentOrders: Order[] = [];

  private mainLoopInterval: NodeJS.Timeout | null = null;
  private orderSyncInterval: NodeJS.Timeout | null = null;
  private startTime = 0;

  private lastUpdateTime = 0;
  private errorCount = 0;
  private maxErrors = 10;
  private lastMarginRatio = 1.0;
  private marginCheckInterval: NodeJS.Timeout | null = null;

  constructor(exchange: ExchangeName, symbol: string, overrides?: Partial<MarketMakerConfig>) {
    this.config = mergeConfig(exchange, symbol, overrides);
    validateConfig(this.config);

    this.exchange = createExchange(exchange);
    this.fairPriceCalc = new FairPriceCalculator(symbol, {
      priceSource: this.config.priceSource,
      windowMs: this.config.fairPriceWindowMs,
      warmupMs: this.config.warmupSeconds * 1000,
    });
    this.quoter = new Quoter(this.config);
    this.positionManager = new PositionManager(this.config);
  }

  /**
   * Start the market maker
   */
  async start(): Promise<void> {
    if (this.state !== "stopped") {
      logger.warn("Market maker already running");
      return;
    }

    try {
      this.state = "connecting";
      this.startTime = Date.now();
      logger.info(`Starting market maker for ${this.config.symbol} on ${this.config.exchange}`);

      // Connect to exchange
      await this.exchange.connect();

      // Get market info
      const markets = await this.exchange.getMarkets();
      this.market =
        markets.find(
          (m) =>
            m.base.toLowerCase() === this.config.symbol.toLowerCase() ||
            m.symbol === this.config.symbol
        ) ?? null;

      if (!this.market) {
        throw new Error(`Market not found for symbol: ${this.config.symbol}`);
      }

      logger.info(`Market found: ${this.market.symbol} (${this.market.id})`);
      this.quoter.setMarket(this.market);

      // Subscribe to orderbook (for potential future use)
      await this.exchange.subscribeOrderbook(this.config.symbol, (_book) => {
        // Could be used for spread adjustment based on book depth
      });

      // Connect to price feed
      await this.fairPriceCalc.connect();

      // Start warmup phase
      this.state = "warming_up";
      logger.info(`Warming up for ${this.config.warmupSeconds} seconds...`);

      // Wait for warmup
      await this.waitForWarmup();

      // Start main loop
      this.state = "running";
      logger.info("Market maker running!");

      // Initial position sync
      await this.syncPosition();

      // Cancel any existing orders
      await this.cancelAllOrders();

      // Start main loop
      this.startMainLoop();

      // Start order sync interval
      this.startOrderSync();

      // Start margin monitoring
      this.startMarginCheck();
    } catch (error) {
      this.state = "error";
      logger.error("Failed to start market maker:", error);
      throw error;
    }
  }

  /**
   * Stop the market maker
   */
  async stop(): Promise<void> {
    logger.info("Stopping market maker...");

    // Stop intervals
    if (this.mainLoopInterval) {
      clearInterval(this.mainLoopInterval);
      this.mainLoopInterval = null;
    }

    if (this.orderSyncInterval) {
      clearInterval(this.orderSyncInterval);
      this.orderSyncInterval = null;
    }

    if (this.marginCheckInterval) {
      clearInterval(this.marginCheckInterval);
      this.marginCheckInterval = null;
    }

    // Cancel all orders
    try {
      await this.cancelAllOrders();
    } catch (error) {
      logger.error("Failed to cancel orders on stop:", error);
    }

    // Disconnect
    try {
      await this.exchange.unsubscribeOrderbook(this.config.symbol);
      await this.exchange.disconnect();
    } catch (error) {
      logger.error("Failed to disconnect exchange:", error);
    }

    try {
      this.fairPriceCalc.disconnect();
    } catch (error) {
      logger.error("Failed to disconnect price feed:", error);
    }

    this.state = "stopped";
    logger.info("Market maker stopped");
  }

  /**
   * Wait for warmup period
   */
  private async waitForWarmup(): Promise<void> {
    return new Promise((resolve) => {
      const checkWarmup = () => {
        if (this.fairPriceCalc.isReady()) {
          resolve();
        } else {
          const remaining = this.fairPriceCalc.getWarmupRemainingMs();
          logger.debug(
            `Warmup: ${(remaining / 1000).toFixed(1)}s remaining, ${this.fairPriceCalc.getPriceCount()} prices`
          );
          setTimeout(checkWarmup, 1000);
        }
      };
      checkWarmup();
    });
  }

  /**
   * Start the main trading loop
   */
  private startMainLoop(): void {
    this.mainLoopInterval = setInterval(() => {
      this.runMainLoop().catch((error) => {
        logger.error("Main loop error:", error);
        this.handleError();
      });
    }, this.config.updateThrottleMs);
  }

  /**
   * Start order sync interval
   */
  private startOrderSync(): void {
    this.orderSyncInterval = setInterval(() => {
      this.syncOrders().catch((error) => {
        logger.error("Order sync error:", error);
      });
    }, this.config.orderSyncIntervalMs);
  }

  /**
   * Start margin ratio monitoring
   */
  private startMarginCheck(): void {
    // Check margin every 10 seconds
    this.marginCheckInterval = setInterval(() => {
      this.checkMarginRatio().catch((error) => {
        logger.error("Margin check error:", error);
      });
    }, 10000);

    // Initial check
    this.checkMarginRatio().catch((error) => {
      logger.error("Initial margin check error:", error);
    });
  }

  /**
   * Check margin ratio and pause if too low
   */
  private async checkMarginRatio(): Promise<void> {
    try {
      const account = await this.exchange.getAccount();

      // Calculate margin ratio: availableMargin / equity
      // Higher is safer, lower means closer to liquidation
      if (account.equity > 0) {
        this.lastMarginRatio = account.availableMargin / account.equity;
      }

      if (this.lastMarginRatio < this.config.minMarginRatio) {
        if (this.state === "running") {
          logger.warn(
            `Margin ratio ${(this.lastMarginRatio * 100).toFixed(1)}% below minimum ${(this.config.minMarginRatio * 100).toFixed(1)}%, pausing...`
          );
          this.state = "paused";

          // Cancel all orders to reduce risk
          await this.cancelAllOrders();
        }
      } else if (
        this.state === "paused" &&
        this.lastMarginRatio >= this.config.minMarginRatio * 1.2
      ) {
        // Resume if margin has recovered with 20% buffer
        logger.info(
          `Margin ratio ${(this.lastMarginRatio * 100).toFixed(1)}% recovered, resuming...`
        );
        this.state = "running";
      }
    } catch (error) {
      logger.error("Failed to check margin ratio:", error);
    }
  }

  /**
   * Main trading loop iteration
   */
  private async runMainLoop(): Promise<void> {
    if (this.state !== "running") {
      return;
    }

    // Throttle updates
    const now = Date.now();
    if (now - this.lastUpdateTime < this.config.updateThrottleMs) {
      return;
    }
    this.lastUpdateTime = now;

    // Get fair price
    const fairPrice = this.fairPriceCalc.getFairPrice();
    if (!fairPrice) {
      logger.debug("No fair price available");
      return;
    }

    // Check if position is at max
    if (this.positionManager.isAtMax()) {
      logger.warn("Position at max, pausing new orders");
      return;
    }

    // Generate quotes
    const signedNotional = this.positionManager.getSignedNotional();
    const quote = this.quoter.generateQuotes(fairPrice, signedNotional);

    // Check if we need to update orders
    const needsUpdate = this.shouldUpdateOrders(quote);
    if (!needsUpdate) {
      return;
    }

    // Cancel existing orders
    await this.cancelAllOrders();

    // Place new orders
    const orders = this.quoter.quoteToOrders(quote);
    for (const order of orders) {
      try {
        const result = await this.exchange.placeOrder(order);
        logger.info(
          `Order placed: ${order.side} ${order.size} @ ${order.price} -> ${result.orderId}`
        );
      } catch (error) {
        logger.error(`Failed to place ${order.side} order:`, error);
      }
    }

    // Reset error count on successful iteration
    this.errorCount = 0;
  }

  /**
   * Check if orders need to be updated
   */
  private shouldUpdateOrders(_quote: { bidPrice: number; askPrice: number }): boolean {
    if (this.currentOrders.length === 0) {
      return true;
    }

    const fairPrice = this.fairPriceCalc.getFairPrice();
    if (!fairPrice) return false;

    // Check if any order is stale
    for (const order of this.currentOrders) {
      if (this.quoter.isOrderStale(order.price, order.side, fairPrice)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Sync position from exchange
   */
  private async syncPosition(): Promise<void> {
    try {
      const positions = await this.exchange.getPositions();
      const position = positions.find(
        (p) => p.symbol.includes(this.config.symbol) || p.symbol === this.market?.symbol
      );

      const fairPrice = this.fairPriceCalc.getFairPrice();
      this.positionManager.updatePosition(position || null, fairPrice || undefined);

      logger.debug(`Position: ${this.positionManager.formatPosition()}`);
    } catch (error) {
      logger.error("Failed to sync position:", error);
    }
  }

  /**
   * Sync orders from exchange
   */
  private async syncOrders(): Promise<void> {
    try {
      this.currentOrders = await this.exchange.getOpenOrders(this.config.symbol);
      await this.syncPosition();
    } catch (error) {
      logger.error("Failed to sync orders:", error);
    }
  }

  /**
   * Cancel all orders
   */
  private async cancelAllOrders(): Promise<void> {
    try {
      await this.exchange.cancelAllOrders(this.config.symbol);
      this.currentOrders = [];
    } catch (error) {
      logger.error("Failed to cancel orders:", error);
    }
  }

  /**
   * Handle errors with circuit breaker
   */
  private handleError(): void {
    this.errorCount++;
    if (this.errorCount >= this.maxErrors) {
      logger.error(`Too many errors (${this.errorCount}), pausing market maker`);
      this.state = "paused";
    }
  }

  /**
   * Get current status
   */
  getStatus(): MarketMakerStatus {
    const position = this.positionManager.getPosition();
    const fairPrice = this.fairPriceCalc.getFairPrice();

    const bidOrder = this.currentOrders.find((o) => o.side === "buy");
    const askOrder = this.currentOrders.find((o) => o.side === "sell");

    return {
      state: this.state,
      exchange: this.config.exchange,
      symbol: this.config.symbol,
      priceSource: this.config.priceSource,
      fairPrice,
      position: {
        side: position.side,
        size: position.size,
        notional: position.notional,
        pnl: position.unrealizedPnl,
      },
      orders: {
        bidPrice: bidOrder?.price || null,
        bidSize: bidOrder?.size || null,
        askPrice: askOrder?.price || null,
        askSize: askOrder?.size || null,
      },
      isCloseMode: this.positionManager.isCloseMode(),
      marginRatio: this.lastMarginRatio,
      uptime: Date.now() - this.startTime,
    };
  }
}

// Export components
export { MarketMakerConfig, mergeConfig, validateConfig, DEFAULT_CONFIG } from "./config.js";
export { Quoter, Quote } from "./quoter.js";
export { PositionManager, PositionState } from "./position.js";
