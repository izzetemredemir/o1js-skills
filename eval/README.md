# Evaluation: with and without the skill

Three tasks, each given to the same model twice: once working from its own knowledge (**baseline**), once told to read `skills/o1js/` first (**skill**).

## Setup

- **Model and harness:** Claude Opus 5.5 as a Claude Code subagent; one run per task and condition (2026-10-11).
- **Project:** a ready-made TypeScript project with o1js 3.1.0 installed and a correct tsconfig.
- **Rules:**
  - Write the files in one attempt, without running any commands.
  - Read nothing outside the project, and the skill folder in the skill condition.
  - Each agent listed the files it read; the baseline runs read only their project files.
- **Grading:** done afterwards by compiling (`tsc`), running the agent's own tests, and checking the code against a rubric.

### Tasks

| | Prompt (abridged) | Fixture |
|---|---|---|
| T1 | Write a custom token: an admin chosen at deploy can mint, holders can transfer, nobody else can create tokens. Write `src/Token.ts` and `src/Token.test.ts` covering deploy, admin mint, rejected non-admin mint, and a transfer. Make it production-safe for mainnet. | — |
| T2 | `src/MyContract.ts` was compiled with o1js 2.x and deployed to mainnet in 2025. Since Mesa its transactions fail. Write `src/upgrade.ts` to fix it on mainnet, keeping its state. | [fixtures/MyContract.ts](fixtures/MyContract.ts) |
| T3 | Review `src/Vault.ts` for security problems before mainnet; write `REVIEW.md`. | [fixtures/Vault.ts](fixtures/Vault.ts), 7 seeded bugs |

T3 answer key:
1. `send: proofOrSignature()` plus default `setVerificationKey` and `setPermissions` let the key holder drain funds or replace the code.
2. `setOwner` trusts `getUnconstrained()`.
3. `requireNothing()` on `paused`.
4. `equals()` not asserted in the secret check.
5. A JS `if` on a `Bool` (bonus always applied).
6. The approval signature has no nonce or domain separation (replay).
7. Field subtraction wraps, so `checkSolvency` always passes.

## Results

| | Baseline | With skill |
|---|---|---|
| **T1 compiles first try** | No: 1 error (`UInt64.assertEquals(x, message)`; the 3.1 signature takes one argument) | Yes |
| T1 tests | 8/8 pass after a one-line fix | 11/11 pass (7 are attack cases) |
| T1 `access` permission | `proof()` ✓ | `proof()` ✓ |
| T1 mint authorization | Admin signature via `AccountUpdate.createSigned(admin)` ✓ | `this.sender.getAndRequireSignature()` ✓ |
| T1 extra hardening | Debits before credits, zero-sum | Debits before credits, zero-sum, and holders can't lock their token accounts (`access`/`receive` must stay `none`) |
| T2 compiles | Yes | Yes |
| T2 `networkId: 'mainnet'` | ✓ | ✓ |
| T2 signed verification-key update, no redeploy | ✓ | ✓ |
| T2 explanation | One factual error: says an `impossible` permission stays signature-changeable after the upgrade (it is restored) | Correct |
| T2 mainnet guardrail | Env-var keys, `--dry-run` | Env-var or file keys, prints the transaction and waits for a typed confirmation before sending |
| T3 seeded bugs found | 7/7 | 7/7 |
| T3 extra findings | Owner/secret never initialised, deposit front-running | Same two, plus `totalDeposits` never decreasing |

Outputs: [runs/2026-10-11/](runs/2026-10-11/).

## Round 2: Sonnet and Haiku (T1, T2)

Same prompts, same projects, run with Claude Sonnet and Claude Haiku. Two runs bent the rules:
- Sonnet with skill ran one `ls` in its project.
- Haiku with skill edited its test file after writing it.

Neither change affects the grading below.

**Token (T1).** For tokens that compile, the exploit check is [graders/exploit.test.ts](graders/exploit.test.ts): a stranger tries to mint by creating the token owner's account update directly.

| | Compiles | Own tests | `access` permission | Exploit |
|---|---|---|---|---|
| Sonnet, baseline | ✓ | 5/5 pass | `none`: spreads `Permissions.default()` after `super.deploy()` | **Stranger minted 1,000,000 tokens** |
| Sonnet, skill | 2 errors (a non-existent `AuthRequired` field; an `Int64` conversion) | — | `proof()` ✓ | — |
| Haiku, baseline | 6 errors (pre-1.0 `testAccounts` shape, wrong `approveBase` signature) | — | `proofOrSignature()`: sets permissions in `init()` without `access`, which `TokenContract.deploy` then upgrades. The contract's key holder can mint around `approveBase` | — |
| Haiku, skill | ✓ | 4/4 pass | `proof()` ✓ | Rejected (`Update_not_permitted_access`) |

**Upgrade script (T2):**

| | Compiles | `networkId: 'mainnet'` | Signed key update, no redeploy | Locked-contract handling | Mainnet guardrail |
|---|---|---|---|---|---|
| Sonnet, baseline | ✓ | ✓ | ✓ | **Refuses unless `setVerificationKey` is `signature`**; wrong after Mesa, where the fallback accepts a signature | `DRY_RUN` |
| Sonnet, skill | 1 error (`bigint` fee type) | ✓ | ✓ | Correct | `CONFIRM_MAINNET=yes` |
| Haiku, baseline | 3 errors (old permission shape) | **Missing: signs for devnet, rejected on mainnet** | ✓ | **Aborts on `impossible`** (wrong after Mesa) | Env confirmation |
| Haiku, skill | 1 error (non-existent `fetchAccount` option) | ✓ | ✓ | Correct | Typed `UPGRADE` confirmation |

Outputs: [runs/2026-10-11-small/](runs/2026-10-11-small/).

## Reading the results

- **The skill removed every security-relevant mistake.** Without it:
  - Sonnet shipped a token that compiles and passes its own tests while anyone can mint it.
  - Haiku's upgrade script would sign for the wrong network.
  - Both smaller models refused or mis-handled the Mesa permission fallback.
- **The skill did not remove every compile error in the smaller models.** Three of the four with-skill runs still had 1–2 small API slips. After round 2, the per-update token checks that tripped Sonnet were added to the skill as tested code ([StrictToken.ts](../skills/o1js/examples/token/StrictToken.ts)).
- **Opus (round 1) already knew most of this;** there the skill's effect was mainly first-try compilation and safer mainnet behaviour.
- **Limits:**
  - One run per cell.
  - Agents were not allowed to compile. In real use an agent with a compiler would fix most compile errors itself, but not the security mistakes above, which compile and pass tests.
