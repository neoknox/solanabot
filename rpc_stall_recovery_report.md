# SolanaBot - Emergency RPC Stall Recovery Report

**Repository:** `neoknox/solanabot`  
**Base Commit:** `40c0f61`  
**Date:** 2026-11-13  
**Status:** RECOVERY COMPLETE — BOUNDED DISCOVERY & ON-CHAIN VERIFICATION OPERATIONAL

---

## 1. Root Cause of Stall & Immediate Termination

### 1.1 Root Cause
During the initial attempt to discover on-chain Orca Whirlpool pool addresses, a one-off script was executed that used `@solana/web3.js`'s raw `Connection` directly against `https://api.mainnet-beta.solana.com` without an explicit socket timeout, abort controller, or rate-limiting throttle. The public Solana RPC dropped or silently rate-limited the TCP connection without returning an HTTP response or throwing an error. Because Node.js default socket fetch has no timeout, the process hung waiting on the socket, and the agent waited on the background task notification.

### 1.2 Action Taken
1. Background task `task-4039` was immediately identified and terminated using `manage_task(Action='kill')`.
2. Verified that all local code, git state, and existing test suites remained completely intact.
3. Implemented a strict, bounded architecture where every external network call (both HTTP API and RPC reads) enforces explicit timeouts, bounded retries, and clean failover.

---

## 2. Bounded Orca Pool Discovery Architecture

Per mission specifications, unbounded RPC scans (`getProgramAccounts`) have been replaced with Orca's official public API: `https://api.orca.so/v2/solana/pools`.

### 2.1 Implementation (`src/scanner/poolDiscovery.ts`)
- **Bounded Pagination:**
  - `pageSize`: Capped at a maximum of 10 results per page (`limit=10`).
  - `maxPages`: Strictly capped at 3 pages per run.
- **Strict Timeouts & Cancellation:**
  - HTTP timeout: 10 seconds enforced via `AbortController`.
  - Retries: Maximum of 1 retry on transient network errors.
- **429 Rate-Limit Handling:**
  - If a `429 Too Many Requests` status is encountered, discovery logs a warning, sets status to `RATE_LIMITED`, and exits cleanly without entering a retry loop.
- **Token Allowlist Gating:**
  - Discovered pools are strictly filtered against canonical allowlisted mints (`CANONICAL_WSOL_MINT`, `CANONICAL_USDC_MINT`, `CANONICAL_USDT_MINT`). All meme tokens and non-canonical mints are immediately discarded.

---

## 3. Targeted On-Chain Verification

Candidate pool addresses are verified on-chain using targeted `getAccountInfo` reads through `SolanaRpcProvider` (with an 8-second cancellable request timeout):

1. **Account Existence:** Verifies account exists on Solana mainnet.
2. **Program Owner:** Validates owner is strictly `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc` (`KNOWN_PROGRAM_IDS.ORCA_WHIRLPOOL`).
3. **Layout Size:** Verifies data buffer is at least 653 bytes.
4. **Token Mints:** Decodes pool state and validates `tokenMintA` and `tokenMintB` match the canonical allowlist.
5. **Fee & Tick Spacing:** Validates positive `feeRate` and `tickSpacing`.
6. **Active Liquidity:** Validates non-zero liquidity or positive TVL.
7. **Quote Status Invariant:** All verified discovered pools are registered strictly as `QUOTE_UNVERIFIED` (`blockerReason: PENDING_TICK_ARRAY_HYDRATION`). They are **never** automatically promoted to `VERIFIED_DIRECT`, and API prices are **never** used as live trading quotes.

---

## 4. Existing Verified Fallback Guarantee

If the Orca API or Solana RPC fails, times out, or encounters a rate limit:
- The existing registry remains 100% intact with all pre-existing verified routes:
  - `Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE` (Orca Whirlpool 4 bps SOL/USDC — `VERIFIED_DIRECT`)
  - `FpCMFDFGYotvufJ7HrFHsWEiiQCGbkLCtwHiDnh7o28Q` (Orca Whirlpool 2 bps SOL/USDC — `VERIFIED_DIRECT`)
  - `4fuUiYxTQ6QCrdSq9ouBYcTM7bqSwYTSyLueGZLTy4T4` (Orca Whirlpool 1 bp USDC/USDT — `VERIFIED_DIRECT`)
  - Raydium AMM V4 pools (`58oQCh...`, `7Xawhb...`)
- Zero dependency on external discovery for core execution and quote validation.

---

## 5. Live Discovery Execution Results

Command executed: `npm run discover:pools` (`tsx src/cli/discoverPools.ts`)

| Metric | Result |
| :--- | :--- |
| **Discovery API Status** | **SUCCESS** |
| **Pages Fetched** | **3 pages** (capped at limit 10) |
| **Discovery Duration** | **3,033 ms** |
| **Candidates Discovered** | **3 candidates** |
| **Existing Pools Skipped** | 2 (`Czfq3xZZ...`, `4fuUiYxT...`) |
| **New Candidates Verified On-Chain** | **1 pool** |
| **Candidates Rejected** | **0** |
| **RPC Errors / Timeouts** | **0** |

### Verified Candidate Details:
- **Pool Address:** `83v8iPyZihDEjDdY8RdZddyZNyUtXngz69Lgo9Kt5d6d`
- **Pair:** SOL / USDC (`So111111...` / `EPjFWd...`)
- **Program Owner:** `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc`
- **Layout Data Length:** 653 bytes
- **Fee Rate:** 100 (1 bp) | **Tick Spacing:** 1
- **Active Liquidity:** `1627642300748`
- **Registry Status:** `QUOTE_UNVERIFIED` (pending tick array streaming)

---

## 6. Files Changed & Added

1. `src/scanner/poolDiscovery.ts` (New):
   - `OrcaPoolDiscovery` service implementing bounded pagination, 10s timeouts, 429 rate limit guards, mint filtering, and targeted on-chain verification.
2. `src/cli/discoverPools.ts` (New):
   - Standalone CLI utility for on-demand bounded discovery and on-chain verification reporting.
3. `package.json`:
   - Added `"discover:pools": "tsx src/cli/discoverPools.ts"` script.
4. `tests/orcaPoolDiscovery.test.ts` (New):
   - 6 comprehensive unit tests covering pagination capping, allowlist filtering, 429 handling, timeout aborts, on-chain rejection conditions, and QUOTE_UNVERIFIED registration.

---

## 7. Test Results & Validation

- **TypeScript Typecheck:** `npm run typecheck` $\to$ **0 errors**.
- **Full Test Suite:** `npm test` $\to$ **133 / 133 tests passed across 21 test files**:
  - All 127 existing tests preserved without modification.
  - 6 new tests in `tests/orcaPoolDiscovery.test.ts` passing.
- **Safety Compliance:**
  - Strictly read-only.
  - Zero private keys loaded.
  - Zero live trading / transactions broadcast.
  - Zero paid RPC services.
  - No unbounded wait loops.
