# SolanaBot Project Rules & Development Policy

This document establishes the binding architectural, developmental, and operational rules for the SolanaBot repository. All AI agents, contributors, and automation processes operating in this codebase must adhere strictly to these policies at all times.

---

## 1. Authoritative Specification & Inclusion

The approved SolanaBot 90-Day Master Roadmap is the authoritative, binding project specification.

@[SolanaBot Master Roadmap](docs/SOLANABOT_MASTER_ROADMAP.md)

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
