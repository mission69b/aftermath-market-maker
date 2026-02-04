import type {
  Account,
  Market,
  Order,
  OrderRequest,
  OrderResult,
  Orderbook,
  Position,
} from "../types.js";

/**
 * Unified exchange interface for multi-exchange support.
 * All exchange adapters must implement this interface.
 */
export interface IExchange {
  /** Exchange name (e.g., "hyperliquid", "aftermath") */
  readonly name: string;

  /** Whether the exchange is currently connected */
  readonly connected: boolean;

  // Connection lifecycle
  /**
   * Connect to the exchange and initialize clients/websockets
   */
  connect(): Promise<void>;

  /**
   * Disconnect from the exchange and cleanup resources
   */
  disconnect(): Promise<void>;

  // Market data
  /**
   * Get all available markets from the exchange
   */
  getMarkets(): Promise<Market[]>;

  /**
   * Subscribe to orderbook updates for a symbol
   * @param symbol - Trading symbol (e.g., "BTC")
   * @param callback - Called on each orderbook update
   * @returns Promise that resolves when subscription is established
   */
  subscribeOrderbook(symbol: string, callback: (book: Orderbook) => void): Promise<void>;

  /**
   * Unsubscribe from orderbook updates for a symbol
   * @param symbol - Trading symbol
   */
  unsubscribeOrderbook(symbol: string): Promise<void>;

  // Account management
  /**
   * Get account information (balance, margin, etc.)
   */
  getAccount(): Promise<Account>;

  /**
   * Get all open positions
   */
  getPositions(): Promise<Position[]>;

  /**
   * Get open orders, optionally filtered by symbol
   * @param symbol - Optional symbol filter
   */
  getOpenOrders(symbol?: string): Promise<Order[]>;

  // Trading operations
  /**
   * Place a new order
   * @param order - Order parameters
   * @returns Order result with exchange-assigned ID
   */
  placeOrder(order: OrderRequest): Promise<OrderResult>;

  /**
   * Cancel an existing order by ID
   * @param orderId - Exchange order ID
   * @param symbol - Symbol (required for some exchanges like Aftermath)
   */
  cancelOrder(orderId: string, symbol?: string): Promise<void>;

  /**
   * Cancel all open orders, optionally filtered by symbol
   * @param symbol - Optional symbol filter
   */
  cancelAllOrders(symbol?: string): Promise<void>;
}
