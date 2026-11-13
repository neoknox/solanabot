# SolanaBot Project Rules & Development Policy

This document establishes the binding architectural, developmental, and operational rules for the SolanaBot repository. All AI agents, contributors, and automation processes operating in this codebase must adhere strictly to these policies at all times.

---

## 1. Authoritative Specification & Inclusions

The approved SolanaBot 90-Day Master Roadmap and AI Supervisor Policy are the authoritative, binding project specifications.

@[SolanaBot Master Roadmap](docs/SOLANABOT_MASTER_ROADMAP.md)
@[SolanaBot AI Supervisor Policy](docs/AI_SUPERVISOR_POLICY.md)

---

## 2. Core Operational Rules

1. **Authoritative Specification:** The approved roadmap is the authoritative project specification. All implementation decisions, route definitions, and milestone criteria must conform directly to it.
2. **Mandatory Roadmap Review:** Always read the full roadmap (`docs/SOLANABOT_MASTER_ROADMAP.md`) before planning or modifying code.
3. **Strict Phase Authorization:** Follow only the current authorized phase. Do not begin work on unapproved milestones.
4. **No Autonomous Phase Jumping:** Never jump to future phases without explicit user approval.
5. **Immutable Project Invariants:** Never change route readiness definitions, virtual capital allocation (1,000 USDC shared), trading model, or safety rules without explicit user approval.
6. **Reuse Existing Infrastructure:** Reuse existing TypeScript, SQLite, Orca/Raydium adapters, RouteIndex, EventQueue, StateCache, profit calculator, and localhost HUD. Do not overengineer or introduce unnecessary third-party services.
7. **Strict Gate Verification:** Confirm all unit/integration tests and phase completion gates pass cleanly before declaring any phase complete.
8. **Empirical Reporting Integrity:** Report real, measured results and verified benchmarks only. Never present estimates, theoretical throughputs, or synthetic simulations as verified live performance.
9. **Strict Read-Only Enforcement:** Do not implement wallets, private key handling, signing, or transaction broadcasts during this read-only roadmap.
10. **Documentation Isolation:** Never treat roadmap installation or documentation updates as permission to start coding. All implementation requires explicit user authorization.

---

## 3. AI Supervisor Governance Policy

1. **Out-of-Band Analysis Only:** AI is strictly a supervisory observer (monitoring route database health, identifying coverage gaps, reviewing performance, detecting operational failures, summarizing opportunities, and compiling daily intelligence reports).
2. **Deterministic Fast Path:** Real-time quoting, pricing, sizing, and trading decisions are strictly 100% deterministic code. AI must NEVER sit inside the critical runtime path.
3. **No Synthetic Evidence:** AI must NEVER invent, fabricate, or approve blockchain verification evidence.
4. **No Autonomous Rule Mutation:** AI must NEVER alter profit thresholds, safety buffers, or validation gates without authorization.
5. **Zero Fund Control:** AI must NEVER hold private keys, sign transactions, or move funds.
6. **Cost Discipline:** Reuse SQLite and local telemetry. Aggregate data before analysis; avoid per-route/per-quote AI API calls. Start with one daily report.
7. **No Separate Platform:** Do NOT build a separate AI platform or microservice. Implement only after reliable route telemetry and persistence exist.
