# Aftermath Market Maker

A multi-exchange perpetuals market maker bot supporting **Aftermath Perpetuals** (Sui) and **Hyperliquid**, using **Binance** or **Hyperliquid** as the price oracle.

## Features

- **Multi-exchange support** - Trade on Aftermath or Hyperliquid with a unified interface
- **Configurable price oracle** - Use Binance spot or Hyperliquid perps for fair price
- **EMA-based fair pricing** - Smooth price calculation with configurable window
- **Position risk management** - Close mode with reduce-only orders when position exceeds threshold
- **Real-time monitoring** - TUI monitor for orderbook and position visualization
- **Graceful shutdown** - Cancels all orders on exit

## Quick Start

```bash
# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
# Edit .env with your keys

# Run on Hyperliquid
npm run bot -- --exchange hyperliquid --symbol BTC

# Run on Aftermath
npm run bot -- --exchange aftermath --symbol BTC

# Monitor market data
npm run monitor -- --exchange hyperliquid --symbol BTC
```

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `EXCHANGE` | Exchange: `aftermath` or `hyperliquid` |
| `SYMBOL` | Trading symbol (e.g., `BTC`, `ETH`) |

### Aftermath (Sui)

| Variable | Description |
|----------|-------------|
| `SUI_PRIVATE_KEY` | Sui wallet private key (base64 or hex) |

### Hyperliquid

| Variable | Description |
|----------|-------------|
| `HL_PRIVATE_KEY` | EVM private key (0x-prefixed hex) |
| `HL_TESTNET` | Use testnet: `true` or `false` |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `PRICE_SOURCE` | `binance` | Price oracle: `binance` or `hyperliquid` |
| `SPREAD_BPS` | `10` | Spread in basis points (10 = 0.1%) |
| `ORDER_SIZE_USD` | `100` | Order size in USD |
| `CLOSE_THRESHOLD_USD` | `500` | Switch to close mode threshold |
| `MAX_POSITION_USD` | `2000` | Maximum position before stopping |
| `WARMUP_SECONDS` | `10` | Wait before quoting |
| `LOG_LEVEL` | `info` | Logging level |

## CLI Options

```bash
npm run bot -- [options]

Options:
  -e, --exchange <exchange>     Exchange (aftermath, hyperliquid)
  -s, --symbol <symbol>         Trading symbol (BTC, ETH, etc.)
  -p, --price-source <source>   Price oracle (binance, hyperliquid)
  --spread-bps <bps>            Spread in basis points
  --order-size <usd>            Order size in USD
  --close-threshold <usd>       Close mode threshold
  --max-position <usd>          Maximum position
  --warmup <seconds>            Warmup period
```

## Architecture

```
src/
├── bots/mm/          # Market maker bot
│   ├── index.ts      # Main loop
│   ├── config.ts     # Configuration
│   ├── position.ts   # Position tracking
│   └── quoter.ts     # Quote generation
├── cli/              # Entry points
│   ├── bot.ts        # Bot CLI
│   └── monitor.ts    # Market monitor
├── exchanges/        # Exchange adapters
│   ├── types.ts      # IExchange interface
│   ├── aftermath/    # Sui perpetuals
│   └── hyperliquid/  # Hyperliquid
├── pricing/          # Price feeds
│   ├── binance.ts    # Binance WebSocket
│   ├── hyperliquid.ts # Hyperliquid mid prices
│   └── fair-price.ts # EMA calculator
└── types.ts          # Shared types
```

## How It Works

1. **Connect** - Establishes connection to exchange and price feed
2. **Warm up** - Collects price data to initialize EMA (default: 10s)
3. **Quote** - Places bid/ask orders around fair price with spread
4. **Manage risk** - Monitors position, switches to close mode when threshold exceeded
5. **Repeat** - Continuously updates quotes as price moves

### Close Mode

When position notional exceeds `closeThresholdUsd`:
- Uses tighter spread (`takeProfitBps` instead of `spreadBps`)
- Only quotes on the reducing side (asks for long, bids for short)
- Orders are marked `reduceOnly`

### Position Limits

- `closeThresholdUsd` - Switch to close mode
- `maxPositionUsd` - Stop opening new positions entirely

## Docker

```bash
# Build image
docker build -t aftermath-mm .

# Run Hyperliquid bot
docker compose --profile hyperliquid up -d

# Run Aftermath bot
docker compose --profile aftermath up -d

# Run both
docker compose --profile all up -d

# View logs
docker compose logs -f
```

## Development

```bash
# Lint
npm run lint

# Type check
npm run build

# Test
npm test

# Watch mode
npm run dev -- --exchange hyperliquid --symbol BTC
```

## Risks

⚠️ **This is trading software. Use at your own risk.**

- **Liquidation** - Monitor margin ratio, bot doesn't check this
- **Stale prices** - Network latency affects quote accuracy
- **Exchange issues** - API failures can leave orders orphaned
- **Bugs** - Software may have undiscovered issues

## License

MIT
