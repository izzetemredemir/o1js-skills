# o1js skill

An agent skill that teaches AI coding assistants (Claude Code, Cursor, Codex and others that read `SKILL.md`) to write correct, secure **o1js 3** code for **Mina** zkApps after the **Mesa** hard fork.

## Why

o1js 3.0 and 3.1 shipped in August and September 2026, alongside the Mesa hard fork (mainnet 2026-09-03). Most o1js code that models learned from was written for 0.x–2.x. So assistants confidently produce:
- removed APIs;
- `Mina.Network(url)` calls that sign for devnet when you meant mainnet;
- "upgrades" that silently reset permissions;
- tokens anyone can mint.

## What makes it different: every claim is tested

The skill is backed by [`skills/o1js/examples/`](skills/o1js/examples/), a small o1js 3.1.0 project whose tests reproduce what the skill says:

- **API facts:** removed exports, renamed methods, default network id, and return shapes, pinned by runtime tests and compile-time `@ts-expect-error` checks.
- **Behaviour:** Mesa limits (16 segments, 32 state fields), the verification-key upgrade path, and that `deploy()` resets permissions.
- **Attacks:** a token with `access: none` minted by a stranger, a token with `access: proofOrSignature` minted by its key holder, and the correct token rejecting both.
- **Pitfalls:** JS `if` on a `Bool`, unasserted `equals()`, read-after-write, `toBoolean()` in circuits, Poseidon padding collisions, `Provable.if` evaluating both branches, reducer limits, and `OffchainState` silently dropping a stale transfer.

```bash
npm install
npm test             # link check + type check + all tests without proofs (~15 s)
npm run test:proofs  # the same tests with real proofs (~6 min)
```

When a new o1js version changes something, these tests fail first.

## Does it help?

[eval/](eval/) gives Claude Opus, Sonnet and Haiku the same tasks with and without the skill and grades the results. Highlights:
- Without the skill, Sonnet wrote a token that compiled and passed its own tests, and a stranger then minted 1,000,000 of it. With the skill, Sonnet and Haiku both locked `access`, and the same attack was rejected.
- Without the skill, Haiku's mainnet upgrade script signed for devnet, and both smaller models mishandled Mesa's permission fallback. With the skill, all runs got both right.
- Opus already knew most of this; the skill's gain there was first-try compilation and safer mainnet behaviour.

## Install

Any agent that supports Agent Skills (Claude Code, Codex, Cursor, Gemini CLI, …), via the [skills CLI](https://www.skills.sh/):

```bash
npx skills add izzetemredemir/o1js-skills
```

Claude Code plugin:

```
/plugin marketplace add izzetemredemir/o1js-skills
/plugin install o1js-skills
```

Manual (Claude Code, personal skill):

```bash
git clone https://github.com/izzetemredemir/o1js-skills
mkdir -p ~/.claude/skills
ln -s "$PWD/o1js-skills/skills/o1js" ~/.claude/skills/o1js
```

For a single project, link it into that project's `.claude/skills/` instead. Other tools: point them at `skills/o1js/SKILL.md`. The references and examples are plain markdown and TypeScript.

## Contents

| Path | What |
|---|---|
| [`skills/o1js/SKILL.md`](skills/o1js/SKILL.md) | Entry point: defaults, the most common outdated patterns, core patterns, security checklist, agent guardrails |
| [`references/migration.md`](skills/o1js/references/migration.md) | Every app-facing API change from 0.18 to 3.1, by area |
| [`references/mesa.md`](skills/o1js/references/mesa.md) | What Mesa changed, how to upgrade a pre-Mesa contract, known documentation bugs |
| [`references/security.md`](skills/o1js/references/security.md) | 20 pitfall classes with wrong/right code, drawn from public audits and o1js-scan |
| [`references/contracts.md`](skills/o1js/references/contracts.md), [`provable-code.md`](skills/o1js/references/provable-code.md), [`transactions.md`](skills/o1js/references/transactions.md), [`zkprogram.md`](skills/o1js/references/zkprogram.md), [`actions-and-offchain-state.md`](skills/o1js/references/actions-and-offchain-state.md), [`tokens.md`](skills/o1js/references/tokens.md), [`testing.md`](skills/o1js/references/testing.md), [`errors.md`](skills/o1js/references/errors.md) | Topic references |
| [`skills/o1js/examples/`](skills/o1js/examples/) | Tested contracts and the tests behind the claims |

## Sources

- [o1js](https://github.com/o1-labs/o1js) source and CHANGELOG (3.1.0)
- [docs.o1labs.org](https://docs.o1labs.org) and [docs.minaprotocol.com](https://docs.minaprotocol.com)
- [o1js-scan](https://github.com/auditinfra-io/o1js-scan) rules
- Public audits: [zkSecurity](https://reports.zksecurity.xyz) (Mina treasury, Zeko) and [Veridise](https://veridise.com) (o1js, fungible token standard, Lumina, Silvana NFT, FROST multisig)

Where these sources disagree with o1js 3.1's behaviour, the skill follows the tests and lists the discrepancy in [`references/mesa.md`](skills/o1js/references/mesa.md#known-documentation-bugs).

## Status

Version 0.1.0, targeting o1js 3.1.0. Corrections and test cases are welcome: open an issue or a pull request.

## License

[MIT](LICENSE)
