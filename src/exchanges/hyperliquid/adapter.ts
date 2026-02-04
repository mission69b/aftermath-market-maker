import type {
  Account,
  Market,
  Order,
  OrderRequest,
  OrderResult,
  Orderbook,
  Position,
} from "../../types.js";
import { logger } from "../../utils/logger.js";
import type { IExchange } from "../types.js";
import { getAccount as fetchAccount, getPositions as fetchPositions } from "./account.js";
import { type HyperliquidClients, createHyperliquidClient } from "./client.js";
import { getMarkets as fetchMarkets } from "./markets.js";
import { HyperliquidOrderbookSubscription } from "./orderbook.js";
import {
  cancelAllOrders as cancelAllHLOrders,
  cancelOrder as cancelHLOrder,
  getOpenOrders as fetchOpenOrders,
  placeOrder as placeHLOrder,
} from "./orders.js";

export interface HyperliquidAdapterConfig {
  privateKey: string;
  isTestnet?: boolean;
}

/**
 * Hyperliquid exchange adapter implementing the unified IExchange interface.
 * Provides a standardized interface to interact with Hyperliquid perpetuals.
 */
export class HyperliquidAdapter implements IExchange {
  readonly name = "hyperliquid";
  private clients: HyperliquidClients;
  private orderbookSubscription: HyperliquidOrderbookSubscription;
  private orderbookCallbacks: Map<string, (book: Orderbook) => void>;
  private _connected = false;

  constructor(config: HyperliquidAdapterConfig) {
    this.clients = createHyperliquidClient(config);
    this.orderbookSubscription = new HyperliquidOrderbookSubscription({
      isTestnet: config.isTestnet,
    });
    this.orderbookCallbacks = new Map();
  }

  get connected(): boolean {
    return this._connected && this.orderbookSubscription.connected;
  }

  /**
   * Connect to Hyperliquid - validates clients are working
   */
  async connect(): Promise<void> {
    try {
      logger.info("Connecting to Hyperliquid...");

      // Test connection by fetching account
      await this.getAccount();

      this._connected = true;
      logger.info("Successfully connected to Hyperliquid");
    } catch (error) {
      logger.error("Failed to connect to Hyperliquid", error);
      throw error;
    }
  }

  /**
   * Disconnect from Hyperliquid and cleanup resources
   */
  async disconnect(): Promise<void> {
    try {
      logger.info("Disconnecting from Hyperliquid...");

      // Unsubscribe from all orderbook subscriptions
      await this.orderbookSubscription.disconnect();

      // Clear callbacks
      this.orderbookCallbacks.clear();

      this._connected = false;
      logger.info("Successfully disconnected from Hyperliquid");
    } catch (error) {
      logger.error("Failed to disconnect from Hyperliquid", error);
      throw error;
    }
  }

  /**
   * Get all available markets from Hyperliquid
   */
  async getMarkets(): Promise<Market[]> {
    return fetchMarkets(this.clients);
  }

  /**
   * Subscribe to orderbook updates for a symbol
   * @param symbol - Trading symbol (e.g., "BTC" or "BTC/USD:USD")
   * @param callback - Called on each orderbook update
   */
  async subscribeOrderbook(symbol: string, callback: (book: Orderbook) => void): Promise<void> {
    // Extract base symbol (e.g., "BTC" from "BTC/USD:USD")
    const base = symbol.includes("/") ? symbol.split("/")[0] : symbol;

    if (!base) {
      throw new Error(`Invalid symbol: ${symbol}`);
    }

    // Store callback for potential reconnection
    this.orderbookCallbacks.set(base, callback);

    // Subscribe via orderbook subscription manager
    try {
      await this.orderbookSubscription.subscribeOrderbook(base, callback);
    } catch (error) {
      logger.error(`Failed to subscribe to orderbook for ${symbol}`, error);
      throw error;
    }
  }

  /**
   * Unsubscribe from orderbook updates for a symbol
   * @param symbol - Trading symbol
   */
  async unsubscribeOrderbook(symbol: string): Promise<void> {
    // Extract base symbol
    const base = symbol.includes("/") ? symbol.split("/")[0] : symbol;

    if (!base) {
      throw new Error(`Invalid symbol: ${symbol}`);
    }

    // Remove callback
    this.orderbookCallbacks.delete(base);

    // Unsubscribe via orderbook subscription manager
    try {
      await this.orderbookSubscription.unsubscribeOrderbook(base);
    } catch (error) {
      logger.error(`Failed to unsubscribe from orderbook for ${symbol}`, error);
    }
  }

  /**
   * Get account information (balance, margin, etc.)
   */
  async getAccount(): Promise<Account> {
    return fetchAccount(this.clients.info, this.clients.wallet);
  }

  /**
   * Get all open positions
   */
  async getPositions(): Promise<Position[]> {
    return fetchPositions(this.clients.info, this.clients.wallet);
  }

  /**
   * Get open orders, optionally filtered by symbol
   * @param symbol - Optional symbol filter
   */
  async getOpenOrders(symbol?: string): Promise<Order[]> {
    return fetchOpenOrders(this.clients, symbol);
  }

  /**
   * Place a new order
   * @param order - Order parameters
   * @returns Order result with exchange-assigned ID
   */
  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    return placeHLOrder(this.clients, order);
  }

  /**
   * Cancel an existing order by ID
   * @param orderId - Exchange order ID
   */
  async cancelOrder(orderId: string): Promise<void> {
    return cancelHLOrder(this.clients, orderId);
  }

  /**
   * Cancel all open orders, optionally filtered by symbol
   * @param symbol - Optional symbol filter
   */
  async cancelAllOrders(symbol?: string): Promise<void> {
    return cancelAllHLOrders(this.clients, symbol);
  }
}

/**
 * Create a Hyperliquid adapter from environment variables
 */
export function createHyperliquidAdapterFromEnv(): HyperliquidAdapter {
  const privateKey = process.env.HL_PRIVATE_KEY;
  const isTestnet = process.env.HL_TESTNET === "true";

  if (!privateKey) {
    throw new Error("HL_PRIVATE_KEY environment variable is required for Hyperliquid");
  }

  return new HyperliquidAdapter({ privateKey, isTestnet });
}
