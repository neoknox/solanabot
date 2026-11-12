# Solana Arbitrage Research Bot - Phase 1: Read-Only, Multi-DEX Scanner

A production-disciplined, read-only Solana arbitrage scanner built in Node.js LTS and TypeScript on Windows.

> **CRITICAL PHASE 1 SAFETY GUARANTEE**  
> This system is **100% READ-ONLY**. It contains **ZERO private keys, ZERO seed phrases, ZERO transaction signing, and ZERO execution code**. It does not fund wallets, sign instructions, or broadcast transactions.

---

## Architecture Overview

```
src/
├── config/             # Validated configuration (Zod), canonical token mints, verified program IDs
├── dex/                # Verified on-chain DEX adapters (Raydium AMM, Orca Whirlpool, Meteora DLMM)
├── profit/             # Deterministic integer arithmetic (BigInt), Decimal.js, cost & slippage models
├── providers/          # Solana RPC client, WebSocket streamer, Jupiter discovery/quoting
├── scanner/            # Pool registry, state cache, multi-size scheduler, deduplication
├── storage/            # Local SQLite database (WAL mode), bounded retention, CSV exporter
└── cli/                # Terminal output, database reporting, live mainnet smoke testing
tests/                  # 20-point reliability & safety test suite (Vitest)
```

---

## Monitored Venues & Coverage Status

| DEX Venue | Category | On-Chain Program ID | Quote Feasibility | Status |
| :--- | :--- | :--- | :--- | :--- |
| **Raydium AMM V4** | Direct Pool | `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8` | Exact constant-product formula + vault reserves | **DIRECT_SUPPORTED** |
| **Orca Whirlpools** | Direct Pool | `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc` | Concentrated liquidity tick math + Q64.64 | **DIRECT_SUPPORTED** |
| **Meteora DLMM** | Direct Pool | `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` | Dynamic bin step price math | **DIRECT_SUPPORTED** |
| **Raydium CLMM** | On-chain Metis | `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK` | Jupiter Metis `/build` composable route | **JUPITER_BUILD_METIS** |
| **Phoenix** | On-chain Metis | `PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY` | Jupiter Metis `/build` composable route | **JUPITER_BUILD_METIS** |
| **ZeroFi / SolFi / HumidiFi** | Proprietary RFQ | Proprietary / Off-chain | RFQ / Managed order only (non-composable) | **PROPRIETARY_RESTRICTED** |
| **OpenBook V2** | On-chain CLOB | `opnbkNmquXGDVnvrgnvbmvswYcDqNtFtxYnhNPprZGF` | No active deep SOL/USDC direct liquidity | **UNSUPPORTED** |
| **PumpSwap / Pump.fun** | Bonding Curve | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` | No SOL/USDC pool (token/SOL bonding only) | **UNSUPPORTED** |

---

## Getting Started (Windows PowerShell)

### Prerequisites
- Node.js LTS (v20+ or v22+)
- npm (v10+)
- Windows PowerShell

### 1. Installation
```powershell
# Navigate to the project directory
cd "C:\Users\HP\.gemini\antigravity\scratch\solana-arbitrage-bot"

# Install pinned dependencies
npm install
```

### 2. Run Typecheck & Automated Test Suite
```powershell
# Verify TypeScript compilation with zero errors
npm run typecheck

# Run the 20-point deterministic safety & reliability test suite
npm run test
```

### 3. Run Live Mainnet Scanner
```powershell
# Start the live read-only scanner against Solana mainnet
npm run scanner
```

### 4. Run Smoke Test & Reports
```powershell
# Execute a 20-second smoke test capturing live quotes and slots
npm run scanner:smoke

# View database metrics, candidate breakdown, and audit proof
npm run report

# Export all logged signals to CSV
npm run export:csv
```

---

## Configuration (`.env`)

| Variable | Default | Description |
| :--- | :--- | :--- |
| `SOLANA_RPC_HTTP` | `https://api.mainnet-beta.solana.com` | Solana HTTP RPC endpoint (free tier compatible) |
| `SOLANA_RPC_WS` | `wss://api.mainnet-beta.solana.com` | Solana WebSocket endpoint for slot & account updates |
| `JUPITER_API_KEY` | `""` | Optional free-tier API key for Jupiter portal |
| `SCAN_TOKENS` | `SOL,USDC` | Token allowlist (canonical WSOL & USDC only) |
| `TRADE_SIZES_USDC` | `25,50,100,250,500,1000` | Simulated trade sizes in USDC |
| `VIRTUAL_CAPITAL_USDC` | `1000` | Upper bound virtual capital filter |
| `MIN_NET_PROFIT_USDC` | `0.50` | Minimum net profit hurdle in USDC after all variable fees |
| `SAFETY_BUFFER_USDC` | `0.25` | Additional conservative safety buffer deducted before qualification |
| `SLIPPAGE_BPS_LEG1` | `10` | Conservative downside slippage allowance on leg 1 (0.10%) |
| `SLIPPAGE_BPS_LEG2` | `10` | Conservative downside slippage allowance on leg 2 (0.10%) |
| `MAX_QUOTE_AGE_MS` | `2500` | Freshness threshold for quotes (ms) |
| `MAX_SLOT_GAP` | `10` | Maximum slot discrepancy permitted between leg 1 and leg 2 |
| `DB_PATH` | `./data/arbitrage_scanner.db` | Local SQLite database path (WAL mode) |
| `DB_RETENTION_HOURS` | `24` | Auto-purges records older than 24 hours |

---

## Status Classification

- **`OBSERVED`**: Raw pool state updated on-chain; quotes not yet matched.
- **`PRICED`**: Both legs quoted; time and slot synchronization checks passed.
- **`CANDIDATE`**: Full cost model applied; expected quote net > $0, but conservative net < $0.50.
- **`QUALIFIED_SHADOW`**: Conservative net profit $\ge \$0.50$ after all network fees, priority fees, tips, slippage, and safety buffer.
- **`REJECTED`**: Violated profit hurdle, price impact, or freshness rules. Includes explicit rejection code.
- **`STALE` / `DEGRADED`**: Quote age exceeded or WebSocket disconnected.
- **`EXECUTABLE_VERIFIED`**: **RESERVED FOR FUTURE PHASES**. Never emitted in Phase 1.

---

## Security & Compliance Audit

- **NO Wallet Keypair**: Neither `@solana/web3.js` `Keypair.generate()`, `fromSecretKey`, nor `fromSeed` is imported or used anywhere in `src/`.
- **NO Transaction Broadcasting**: No `sendTransaction`, `sendRawTransaction`, or signing methods exist.
- **Integer Math Precision**: All token amounts are computed in integer base units (`BigInt`). All financial accounting is evaluated using `Decimal.js` (30-digit precision) to eliminate floating-point rounding bugs.
