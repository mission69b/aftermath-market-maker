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
import {
  clearAccountCache,
  getAccount as fetchAccount,
  getAccountCap,
  getPositionsForWallet,
} from "./account.js";
import { AftermathClient } from "./client.js";
import { getMarkets as fetchMarkets, getMarketBySymbol } from "./markets.js";
import { AftermathOrderbookSubscription } from "./orderbook.js";
import {
  cancelOrder as cancelAftermathOrder,
  cancelOrders,
  getOpenOrders as fetchOpenOrders,
  getAllOpenOrders,
  placeOrder as placeAftermathOrder,
} from "./orders.js";
import { SuiSigner } from "./signer.js";

export interface AftermathAdapterConfig {
  privateKey?: string; // Sui private key (or use env var)
  baseUrl?: string; // API base URL (or use env var)
}

/**
 * Aftermath exchange adapter implementing the unified IExchange interface.
 * Provides a standardized interface to interact with Aftermath Perpetuals on Sui.
 */
export class AftermathAdapter implements IExchange {
  readonly name = "aftermath";
  private client: AftermathClient;
  private signer: SuiSigner;
  private walletAddress: string;
  private orderbookSubscription: AftermathOrderbookSubscription;
  private orderbookCallbacks: Map<string, (book: Orderbook) => void>;
  private symbolToChId: Map<string, string>; // Cache symbol -> chId mapping
  private _connected = false;

  constructor(config?: AftermathAdapterConfig) {
    this.client = new AftermathClient(config?.baseUrl);
    this.signer = new SuiSigner(config?.privateKey);
    this.walletAddress = this.signer.getWalletAddress();
    this.orderbookSubscription = new AftermathOrderbookSubscription(this.client);
    this.orderbookCallbacks = new Map();
    this.symbolToChId = new Map();
  }

  get connected(): boolean {
    return this._connected;
  }

  /**
   * Connect to Aftermath - validates account exists and is accessible
   */
  async connect(): Promise<void> {
    try {
      logger.info("Connecting to Aftermath...");

      // Verify account exists
      await getAccountCap(this.client, this.walletAddress);

      // Pre-fetch markets to cache symbol mappings
      const markets = await this.getMarkets();
      for (const market of markets) {
        // Map both full symbol and base symbol to chId
        this.symbolToChId.set(market.symbol, market.id);
        this.symbolToChId.set(market.base, market.id);
      }

      this._connected = true;
      logger.info(`Successfully connected to Aftermath with wallet ${this.walletAddress}`);
    } catch (error) {
      logger.error("Failed to connect to Aftermath", error);
      throw error;
    }
  }

  /**
   * Disconnect from Aftermath and cleanup resources
   */
  async disconnect(): Promise<void> {
    try {
      logger.info("Disconnecting from Aftermath...");

      // Disconnect orderbook subscriptions
      await this.orderbookSubscription.disconnect();

      // Clear caches
      this.orderbookCallbacks.clear();
      this.symbolToChId.clear();
      clearAccountCache();

      this._connected = false;
      logger.info("Successfully disconnected from Aftermath");
    } catch (error) {
      logger.error("Failed to disconnect from Aftermath", error);
      throw error;
    }
  }

  /**
   * Get chId for a symbol, with caching
   */
  private async getChIdForSymbol(symbol: string): Promise<string> {
    // Check cache first
    const cached = this.symbolToChId.get(symbol);
    if (cached) return cached;

    // Lookup market
    const market = await getMarketBySymbol(this.client, symbol);
    if (!market) {
      throw new Error(`Market not found for symbol: ${symbol}`);
    }

    // Cache and return
    this.symbolToChId.set(symbol, market.id);
    this.symbolToChId.set(market.base, market.id);
    return market.id;
  }

  /**
   * Get all available markets from Aftermath
   */
  async getMarkets(): Promise<Market[]> {
    return fetchMarkets(this.client);
  }

  /**
   * Subscribe to orderbook updates for a symbol
   * @param symbol - Trading symbol (e.g., "BTC" or "BTC/USD:USDC")
   * @param callback - Called on each orderbook update
   */
  async subscribeOrderbook(symbol: string, callback: (book: Orderbook) => void): Promise<void> {
    try {
      const chId = await this.getChIdForSymbol(symbol);
      this.orderbookCallbacks.set(symbol, callback);
      this.orderbookSubscription.subscribeOrderbook(chId, callback);
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
    try {
      const chId = await this.getChIdForSymbol(symbol);
      this.orderbookCallbacks.delete(symbol);
      this.orderbookSubscription.unsubscribeOrderbook(chId);
    } catch (error) {
      logger.error(`Failed to unsubscribe from orderbook for ${symbol}`, error);
    }
  }

  /**
   * Get account information (balance, margin, etc.)
   */
  async getAccount(): Promise<Account> {
    return fetchAccount(this.client, this.walletAddress);
  }

  /**
   * Get all open positions
   */
  async getPositions(): Promise<Position[]> {
    return getPositionsForWallet(this.client, this.walletAddress);
  }

  /**
   * Get open orders, optionally filtered by symbol
   * @param symbol - Optional symbol filter
   */
  async getOpenOrders(symbol?: string): Promise<Order[]> {
    if (symbol) {
      const chId = await this.getChIdForSymbol(symbol);
      const { accountNumber } = await getAccountCap(this.client, this.walletAddress);
      return fetchOpenOrders(this.client, accountNumber, chId);
    }

    // Get orders from all cached markets
    const marketIds = Array.from(new Set(this.symbolToChId.values()));
    return getAllOpenOrders(this.client, this.walletAddress, marketIds);
  }

  /**
   * Place a new order
   * @param order - Order parameters
   * @returns Order result with exchange-assigned ID
   */
  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    const chId = await this.getChIdForSymbol(order.symbol);
    return placeAftermathOrder(this.client, this.signer, this.walletAddress, chId, order);
  }

  /**
   * Cancel an existing order by ID
   * @param orderId - Exchange order ID
   * @param symbol - Symbol is required for Aftermath to know which market
   */
  async cancelOrder(orderId: string, symbol?: string): Promise<void> {
    if (!symbol) {
      throw new Error("Symbol is required to cancel order on Aftermath");
    }
    const chId = await this.getChIdForSymbol(symbol);
    await cancelAftermathOrder(this.client, this.signer, this.walletAddress, chId, orderId);
  }

  /**
   * Cancel all open orders, optionally filtered by symbol
   * @param symbol - Optional symbol filter (required for efficiency)
   */
  async cancelAllOrders(symbol?: string): Promise<void> {
    if (symbol) {
      const chId = await this.getChIdForSymbol(symbol);
      const { accountNumber } = await getAccountCap(this.client, this.walletAddress);
      const orders = await fetchOpenOrders(this.client, accountNumber, chId);
      if (orders.length > 0) {
        await cancelOrders(
          this.client,
          this.signer,
          this.walletAddress,
          chId,
          orders.map((o) => o.id)
        );
      }
    } else {
      // Cancel across all cached markets
      const marketIds = Array.from(new Set(this.symbolToChId.values()));
      for (const chId of marketIds) {
        try {
          const { accountNumber } = await getAccountCap(this.client, this.walletAddress);
          const orders = await fetchOpenOrders(this.client, accountNumber, chId);
          if (orders.length > 0) {
            await cancelOrders(
              this.client,
              this.signer,
              this.walletAddress,
              chId,
              orders.map((o) => o.id)
            );
          }
        } catch (error) {
          logger.warn(`Failed to cancel orders in market ${chId}:`, error);
        }
      }
    }
  }

  /**
   * Get the wallet address
   */
  getWalletAddress(): string {
    return this.walletAddress;
  }
}

/**
 * Create an Aftermath adapter from environment variables
 */
export function createAftermathAdapterFromEnv(): AftermathAdapter {
  return new AftermathAdapter();
}

// Export sub-modules
export { AftermathClient } from "./client.js";
export { SuiSigner, createSuiSigner } from "./signer.js";
export { getMarkets, getMarketBySymbol, getMarketById } from "./markets.js";
export { getOrderbook, AftermathOrderbookSubscription } from "./orderbook.js";
export {
  getAccount,
  getAccounts,
  getAccountCap,
  getPositions,
  getPositionsForWallet,
  getBalance,
} from "./account.js";
export {
  placeOrder,
  cancelOrder,
  cancelOrders,
  getOpenOrders,
  getAllOpenOrders,
} from "./orders.js";
