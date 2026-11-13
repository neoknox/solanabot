# SOLANABOT: AI SUPERVISOR POLICY
**VERSION 1.0 - APPROVED OPERATIONAL GOVERNANCE**  
**Repository:** `neoknox/solanabot`  

---

## 1. Purpose
Monitor and improve the growing verified arbitrage route network without interfering with deterministic execution.

---

## 2. AI Responsibilities
The AI Supervisor operates strictly out-of-band to:
- **Analyze Route Database Health:** Audit the integrity, deduplication, and persistence of stored route definitions and pool metadata.
- **Identify Discovery Coverage Gaps:** Detect missing pool connections, neglected token pairs, or unmapped multi-DEX cycles.
- **Review Scanner Performance:** Evaluate detection-to-decision latencies, slot lag, queue coalescing, and rejection frequency.
- **Detect Repeated Operational Failures:** Spot persistent RPC timeouts, WebSocket drops, tick-array hydration failures, or adapter math errors.
- **Recommend Route Expansion:** Propose candidate pools and token additions based on empirical on-chain liquidity evidence.
- **Summarize Historical Opportunities:** Aggregate observed shadow opportunities and theoretical profit capture.
- **Generate Daily Intelligence Reports:** Produce scheduled, human-readable operational summaries.

---

## 3. Real-Time Trading Boundary (Strict Determinism)
- **Deterministic Code Only:** The fast path of the scanner and opportunity engine is 100% deterministic TypeScript/Node.js arithmetic.
- **Out of Critical Path:** AI must NEVER sit inside the time-critical quoting, pricing, sizing, or trading decision path.
- **No Evidence Invention:** AI must NEVER invent, fabricate, or unilaterally approve blockchain verification evidence.
- **No Rule Mutation:** AI must NEVER change profit hurdles, safety buffers, slippage tolerances, or safety gates without explicit authorization.
- **Zero Key or Fund Access:** AI must NEVER control private keys, sign transactions, or move funds.

---

## 4. Cost & Efficiency Policy
- **Reuse Existing Infrastructure:** Leverage existing SQLite databases, telemetry trackers, and health summaries.
- **Aggregate Before Analysis:** Process data in batch aggregates rather than triggering per-route or per-quote AI calls.
- **Avoid Per-Route AI API Calls:** Under no circumstances should per-route or per-opportunity LLM queries be executed.
- **Daily Cadence:** Start with one daily AI summary report.
- **Measured Value Expansion:** Expand AI monitoring tasks only if measured operational value justifies additional compute or API costs.

---

## 5. Implementation Roadmap Integration
- **Sequencing:** Integrate only after reliable route telemetry and durable persistence exist (following Phase 1 route library and Phase 4/6 telemetry milestones).
- **No Separate Platform:** Do NOT build a separate AI platform, standalone microservice, or external AI dashboard. Use lightweight in-tree scripts and existing storage.
