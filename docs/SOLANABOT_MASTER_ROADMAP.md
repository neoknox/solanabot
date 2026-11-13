# SOLANABOT: 90-DAY MASTER ROADMAP
**VERSION 1.0 - APPROVED PROJECT DIRECTION**  
**Repository:** `neoknox/solanabot`  
**Baseline at roadmap adoption:** `53018c6d04dd11129aec69e95f865c8e05374609`  

---

## PURPOSE
Build a persistent and expanding network of technically verified Solana arbitrage routes. Keep eligible routes ready for fresh price monitoring, whether currently profitable or not. Detect openings as fast as the current architecture safely supports. Prepare for later atomic simulation and separately authorized execution.

---

## CORE BUSINESS RULES
- The verified route database is the primary long-term asset.
- A route's technical validity is independent of its current profitability.
- Never remove a technically valid route solely for showing zero or negative profit.
- Maintain permanent route definitions separately from ephemeral live state.
- A route marked READY must have complete, fresh, accurately quoted dependencies now. A saved database record alone is not READY.
- Daily bounded Scout discovery and continuous event-driven Sniper monitoring are separate workloads. The Scout never blocks the Sniper's hot path.
- Never reuse historical quotes, balances, expired blockhashes, or stale transaction details to declare an opportunity executable.
- Read-only shadow mode remains mandatory throughout the 90-day route-infrastructure roadmap. No wallet, signing or transaction broadcast. Transaction simulation and live execution require separate later approval.
- Reuse existing TypeScript, SQLite, Orca/Raydium adapters, RPC/WS providers, RouteIndex, EventQueue, StateCache, profit calculator and lightweight localhost HUD. Avoid new paid infrastructure and unnecessary services.
- Do not claim execution dominance, realized profit, or a performance capacity until measured.

---

## TRADING MODEL
- **Network:** Solana mainnet.
- **Strategy:** multi-pair, multi-DEX, directed two-leg and three-leg arbitrage.
- **Accounting and start/end asset:** USDC.
- **Initial token allowlist:** WSOL, USDC, USDT. Expand conservatively to established liquid tokens after correct mint, decimals, transfer behavior, valuation and protocol support are demonstrated.
- **Initial virtual capital:** 1,000 USDC shared across simultaneous shadow opportunities, NOT 1,000 USDC per route.
- **Default candidate trade sizes:** 25, 50, 100, 250, 500, 1,000 USDC. The existing trade sizer finds a viable size.
- **User-controlled conservative net-profit signal threshold:** 0.20-0.70 USDC in 0.05 increments, default 0.50. This threshold filters fresh opportunities only, never route discovery or storage.
- **Current code is a read-only scanner.** Future live capital remains unapproved. A real executor will need separate SOL fee balance and transaction profitability safeguards.

---

## SUCCESS METRICS
- **First milestone:** 100 technically verified directed route definitions.
- **Second:** 250 verified route definitions.
- **Third:** 500 verified route definitions.
- **90-day objective:** 1,000+ technically verified route definitions, subject to real protocol coverage.
- **Stretch objective:** 1,000 simultaneously quote-ready routes ONLY if benchmarks show acceptable freshness, latency, RPC load and zero safety violations.
- **Track separately:** discovered pools, verified pools, stored route definitions, verified routes, presently READY routes, monitored routes, quote-valid checks, qualified shadow signals, detection latency, event queue drops, observed slot lag and stale quote percentage.
- **Do not convert synthetic stress-test results into real mainnet profitability claims.**

---

## ARCHITECTURE
- **SCOUT:** Bounded pool/route discovery, on-chain verification, candidate reconciliation, daily catalog maintenance.
- **DATABASE:** Existing SQLite stores durable pool and directed-route identities, account dependency specifications, verification metadata and historical observations. Avoid duplicate identities.
- **SNIPER:** Existing live WebSocket account tracking and event-driven route evaluation. Load verified routes into the existing in-memory index. Recompute only routes affected by changing pool data.
- **SIGNAL:** Existing conservative cost, price-impact, quote-freshness, slot-gap, sizing and profit checks. Emits QUALIFIED_SHADOW for fresh valid opportunities meeting the HUD threshold.
- **FUTURE EXECUTOR:** Reusable swap metadata and account maps prepare a later atomic transaction builder/simulator. No live execution under this roadmap.

---

## ROUTE DEFINITION
For each directed route retain: unique stable route ID, ordered pool addresses, ordered DEX programs, token path/directions, immutable verified program/mint identities, static and dynamic account dependencies, protocol adapter version, estimated compute and transaction account footprint, last verification details and timestamps. Do not persist a current quote as a permanent executable instruction.

---

## ROUTE STATES
- **DISCOVERED:** Found, not verified.
- **VERIFIED:** Permanent on-chain identities and route structure verified.
- **READY:** Currently fully hydrated, fresh and quote-supported, meeting all safety gates.
- **STALE:** Temporarily non-quotable due to stale/missing data or connectivity.
- **BLOCKED:** Invalid, unsafe or unsupported dependencies.
- **EXECUTION_PREPARED:** Reusable static instruction/account blueprint mapped, not simulated or executable.
- **SIMULATION_VERIFIED:** Reserved for a separate future Phase 2, never assigned during this roadmap.

Profitability is recorded separately from readiness. Correct transitions restore STALE routes automatically after fresh valid state returns.

---

## PHASE 1 - PERMANENT ROUTE LIBRARY (WEEKS 1-2)
Use existing SQLite. Store canonical directed routes, pool verification, token/DEX paths, account dependencies, estimated footprint and verification timestamps. Deduplicate and recover across restart. Preserve unprofitable routes. Avoid schema overengineering.  
**GATE:** Tests prove stable identity, dedupe, persistence, restart recovery and correct distinction of VERIFIED versus READY.

---

## PHASE 2 - AUTOMATIC SCOUT (WEEKS 3-4)
Daily bounded discovery, starting with Orca and Raydium. Verify pool owner, exact mints, liquidity, account layout, pricing dependencies and fee configuration. Generate eligible directed two-leg/three-leg cycles and activate newly READY routes without a restart. Avoid blocking live scanning, public-RPC stalls or unsafe promotions.  
**MILESTONE:** 100 then 250 verified route definitions, contingent on actual coverage.  
**GATE:** Each counted route has independent technical verification and reproducible source evidence.

---

## PHASE 3 - BROADER DEX/TOKEN COVERAGE (WEEKS 5-6)
Expand existing Raydium protocol coverage first, then consider Raydium CPMM/CLMM and Meteora DLMM one at a time when measured coverage gain justifies the adapter. Add selected established liquid tokens only after mint/decimals, transfer rules, account and pricing math checks. Avoid 4+ leg complexity without measured value.  
**MILESTONE:** 500+ verified route definitions if supported by actual pool universe.  
**GATE:** Quote correctness and freshness parity with existing safety tests, no unsupported or fabricated route counts.

---

## PHASE 4 - ALWAYS-READY SNIPER (WEEKS 7-9)
Load verified routes into memory and hydrate live dependencies. Subscribe to relevant accounts. On each meaningful market update, update cache, identify affected READY routes, quote all legs, size, compute conservative net, apply the HUD threshold and emit fresh shadow signals. Preserve and monitor unprofitable routes. No network discovery calls or unnecessary synchronous database writes in the detection hot path.  
Benchmark realistic and deterministic workloads at 100, 250, 500 and 1,000 routes; report route/quote throughput, p50/p95/p99 detection-to-decision time, quote expiry, slot lag, queue drops, CPU, RAM and connection stability.  
**GATE:** State the highest demonstrated safe sustainable capacity, never infer a theoretical limit from queue capacity or route count.

---

## PHASE 5 - SNAP PREPARATION (WEEKS 10-11)
Map verified swap legs, program IDs, token directions, required pool/vault/tick and other accounts, estimated compute, account footprint and dynamic refresh requirements. Provide a low-latency handoff format from QUALIFIED_SHADOW to future transaction assembly. Do not pre-sign or broadcast transactions or claim actual execution verification.  
**GATE:** Reusable static blueprints verified, dynamic data clearly classified, separate Phase 2 simulation requirements documented.

---

## PHASE 6 - RELIABILITY AND FINAL AUDIT (WEEK 12)
Sustain read-only unattended monitoring while hosted, including daily discovery and database updates. Test reconnection, queue pressure, startup rehydration, stale-state quarantining and restoration, rate limits, persistence/restart, CPU/RAM growth, and rejection accuracy. Produce final factual benchmark report separating tested capacity from stretch targets.  
**GATE:** Stable operation and honest evidence-backed assessment; no fabricated signals or speed promises.

---

## SPEED AND COMPETITIVE ADVANTAGE
- Prepare route graphs and account mappings once; refresh only dynamic state.
- Allow new verified pools to generate all technically eligible routes, but avoid duplicating cycles.
- Maintain a self-healing verified/READY/STALE model so transitory outages do not erase route knowledge.
- Measure independent market-state opportunity survival and detection latency, but never discard routes based on historical profitability.
- Use affordable deterministic replay first and live read-only benchmarks second. Only pay for better RPC or hosting once measured bottlenecks warrant spending.
- Actual competitive landing versus industrial MEV bots requires separate later execution architecture, fee bidding, infrastructure and real results. No claims of guaranteed superiority.

---

## PHASE DISCIPLINE
- The approved roadmap is direction, not authorization to implement all phases in one session.
- Work on only the expressly authorized phase/iteration.
- Before each task read this entire roadmap and the root AGENTS.md rule, identify current phase and gate, then inspect current HEAD and existing code.
- At completion: run tests/typecheck, bounded appropriate read-only checks, report actual metrics and remaining blockers, commit and push only verified changes if authorized.
- Do not alter objectives, definitions, target capital, safety policy or phase order without the user's explicit approval.
- If targets exceed safe measured capacity, report the blocker rather than weakening verification or safety gates.
- Each phase ends at its gate. Stop and await the next explicit instruction; no autonomous months-long work or live trading.

---

## POST-ROADMAP
- **FUTURE PHASE 2:** Build our own atomic transaction assembly and use Solana native simulateTransaction without broadcast. Verify execution account requirements, compute usage and conservative profitability under realistic simulation; success does not guarantee live landing.
- **FUTURE PHASE 3:** Only with explicit authorization, develop signing, bundle/transaction submission, fees/bidding, confirmations and realized net-profit measurement.

---

## APPROVED FINAL DIRECTION
The primary asset is the growing database of technically verified Solana shopping routes. Scout continuously grows it. Sniper stays hot on live verified routes. Profitability is a momentary trigger, not a reason to keep or delete routes. The 90-day deliverable is a reliable, persistent, expanding and measurably fast route-intelligence network, ready to enter separate atomic-simulation work.
