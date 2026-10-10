# Changelog

## 0.1.0 — 2026-10-11

First release, targeting o1js 3.1.0 on Mina after the Mesa hard fork.

- `SKILL.md`, with:
  - the outdated patterns models write most often;
  - core patterns;
  - a 13-point security checklist;
  - agent guardrails for keys and mainnet transactions.
- 12 references: migration, Mesa, security, contracts, provable code, transactions, ZkProgram, actions and off-chain state, tokens, frontend, testing, errors.
- 62 tests that run with and without proofs, including attack tests against tokens.
- An evaluation against Claude Opus, Sonnet and Haiku, with and without the skill.
- CI: fast tests on every push; weekly proving run and a check against the newest o1js.
