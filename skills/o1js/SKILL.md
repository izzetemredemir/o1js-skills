---
name: o1js
description: Write, review, debug and upgrade Mina zkApps and zero-knowledge programs with o1js 3.x. Use when the user works with o1js or Mina smart contracts (SmartContract, @state, @method), ZkProgram and recursive proofs, actions and reducers, custom tokens (TokenContract), permissions and verification-key upgrades, Mina transactions and fees, browser zkApp frontends and wallet (Auro) integration, LocalBlockchain or lightnet tests, deploying to Mina devnet or mainnet, the Mesa hard fork, or errors such as "Account_app_state_precondition_unsatisfied", "Update_not_permitted_access", "too many segments" or "Invalid_fee_excess". Corrects the o1js 0.x–2.x APIs that models tend to produce.
license: MIT
compatibility: o1js 3.1.x on Mina after the Mesa hard fork; Node.js >= 22.19.5
metadata:
  version: "0.1.0"
  o1js: "3.1.0"
---

# o1js 3 on Mesa

Your memory of o1js is probably out of date. o1js 3.0 (published 2026-08-18) and 3.1 (published 2026-09-23) shipped alongside the Mesa hard fork (Mina mainnet, 2026-09-03), and most public o1js code was written for 0.x–2.x. Everything here was checked against o1js 3.1.0. Claims that cite an example are reproduced by the tests in [examples/](examples/).

## Before writing code

1. **Check the installed version** (`node_modules/o1js/package.json`). On 3.x, follow this skill. On 2.x or older, read [references/migration.md](references/migration.md) first. Since Mesa, mainnet contracts need o1js 3.
2. **Don't guess signatures.** Read the installed typings: `node_modules/o1js/dist/node/index.d.ts` and `dist/node/lib/**/*.d.ts`. The CHANGELOG in the o1js repo lists every change by version.
3. **Treat docs and tutorials as possibly stale.** Several official pages still show pre-v3 or buggy code ([references/mesa.md](references/mesa.md#known-documentation-bugs)).

## Default stack

- **Versions:** `o1js@^3.1.0` and Node.js ≥ 22.19.5. 3.1.0 fixes account-update soundness bugs in 3.0.x and changes verification keys again.
- **Build with `tsc`.** The tsconfig needs `experimentalDecorators: true`, `emitDecoratorMetadata: true` and `useDefineForClassFields: false`. o1js reads decorator metadata to learn `@method` argument types, and esbuild-based runners (tsx, Vite, Vitest) do not emit it. Template: [examples/tsconfig.json](examples/tsconfig.json).
- **Testing:** `node:test` with `await Mina.LocalBlockchain({ proofsEnabled: false })` for fast logic tests. Run the same suite with proofs enabled before any deployment. See [references/testing.md](references/testing.md).
- **Proving:**
  - Node: `setBackend('native')` at the top of the entry point, before any o1js call that initialises it (`LocalBlockchain`, `compile`, …), or `O1JS_BACKEND=native`, for about 2× faster proving.
  - Browser: WASM inside a Web Worker, served with COOP/COEP headers.
  - Cache keys with `Cache.FileSystem`.
- **zkapp-cli:** `zk project` still scaffolds `"o1js": "^2.*"`. Change it to `^3.1.0` before writing any code.

## What models get wrong most often

| Outdated pattern | o1js 3.1 | Proof |
|---|---|---|
| `Mina.Network(url)` for mainnet | `Mina.Network({ networkId: 'mainnet', mina: url, archive })`; the bare URL defaults to **devnet**, so signatures are invalid on mainnet | [api-surface.test.ts](examples/api-surface/api-surface.test.ts) |
| `Mina.LocalBlockchain()` without await, `testAccounts[0].privateKey` | `const local = await Mina.LocalBlockchain(...)`, `const [alice] = local.testAccounts; alice.key` | same |
| `@method inc() {}` | `@method async inc() {}` and `await zkApp.inc()` | [type-checks.ts](examples/api-surface/type-checks.ts) |
| `Mina.transaction(sender, () => {...})` | `Mina.transaction(sender, async () => {...})` | same |
| `const proof = await Program.m(x)`, method returns `x` | `const { proof } = await Program.m(x)`, method returns `{ publicOutput: x }`; `await Program.verify(proof)` | same, [SumProgram.test.ts](examples/zkprogram/SumProgram.test.ts) |
| `this.x.get()` alone | `this.x.getAndRequireEquals()`; a contract with a bare `get()` does not compile | [Pitfalls.test.ts](examples/pitfalls/Pitfalls.test.ts) |
| `setVerificationKey: Permissions.impossible()` | `setVerificationKey: Permissions.VerificationKey.impossibleDuringCurrentVersion()` (or `.proofDuringCurrentVersion()`, `.signature()`) | [type-checks.ts](examples/api-surface/type-checks.ts) |
| Calling `deploy()` again to upgrade | Signed verification-key update; `deploy()` resets every permission to the defaults | [Upgradable.test.ts](examples/upgrade/Upgradable.test.ts) |
| `AccountUpdate.createIf(c, pk)` used as an `AccountUpdate` | Returns `OptionalAccountUpdate`; use `.value` | [type-checks.ts](examples/api-surface/type-checks.ts) |
| `UInt64.lt`, `Field.isZero`, `Circuit.if`, `CircuitValue`, `isReady` | `lessThan`, `x.equals(0)`, `Provable.if`, `Struct`; `isReady` is gone | [api-surface.test.ts](examples/api-surface/api-surface.test.ts) |
| `encryptV2`, `TokenContractV2`, `divV2`, … | Plain names (`encrypt`, `TokenContract`, `div`) since 2.0 | same |
| `import { fetchActions } from 'o1js'` | `Mina.fetchActions(...)`; `fetchEvents` is still top-level | same |
| `Provable.equal(a, b)` | `Provable.equal(Type, a, b)` | same |
| `uint32.toBigInt()` | `UInt64`/`UInt8`: `toBigInt()`; `UInt32`/`Int64`: `toBigint()` | same |
| `amount.assertEquals(x, 'message')` on `UInt64`/`UInt32` | No message argument there (compile error); use `amount.equals(x).assertTrue('message')`. Comparisons such as `assertLessThanOrEqual` do take one | [type-checks.ts](examples/api-surface/type-checks.ts) |
| `setFeePerSnarkCost`, `TransactionCost.*` | `tx.setFee(...)`; limit is 16 segments per transaction | [Limits.test.ts](examples/limits/Limits.test.ts) |
| 8 state fields | 32 field elements of on-chain state per account | same |
| `Experimental.IndexedMerkleMap` | Top-level `IndexedMerkleMap`; `OffchainState` is still under `Experimental` | [api-surface.test.ts](examples/api-surface/api-surface.test.ts) |

The full list, ordered by version, is in [references/migration.md](references/migration.md).

## Core patterns

Contract, deploy and call ([examples/counter/](examples/counter/)):

```ts
import { AccountUpdate, Field, Mina, PrivateKey, SmartContract, State, method, state } from 'o1js';

export class Counter extends SmartContract {
  @state(Field) count = State<Field>();

  init() {
    super.init();
    this.count.set(Field(0));
  }

  @method async increment() {
    const current = this.count.getAndRequireEquals();
    this.count.set(current.add(1));
  }
}

const local = await Mina.LocalBlockchain({ proofsEnabled: false });
Mina.setActiveInstance(local);
const [sender] = local.testAccounts;
const zkAppKey = PrivateKey.random();
const zkApp = new Counter(zkAppKey.toPublicKey());

const deployTx = await Mina.transaction(sender, async () => {
  AccountUpdate.fundNewAccount(sender); // 1 MINA account creation fee
  await zkApp.deploy();
});
await deployTx.prove();
await deployTx.sign([sender.key, zkAppKey]).send(); // deploy needs the zkApp key's signature

const tx = await Mina.transaction(sender, async () => {
  await zkApp.increment();
});
await tx.prove();
await tx.sign([sender.key]).send();
```

On a live network, configure it and fetch accounts first:

```ts
Mina.setActiveInstance(Mina.Network({ networkId: 'mainnet', mina: GRAPHQL_URL, archive: ARCHIVE_URL }));
await fetchAccount({ publicKey: zkAppAddress });
await fetchAccount({ publicKey: sender });
const tx = await Mina.transaction({ sender, fee: 100_000_000 }, async () => { ... });
await tx.prove();
const pending = await tx.sign([senderKey]).send();
await pending.wait();
```

Topic references:
- Recursion and settling proofs: [references/zkprogram.md](references/zkprogram.md)
- Concurrent updates: [references/actions-and-offchain-state.md](references/actions-and-offchain-state.md)
- Tokens: [references/tokens.md](references/tokens.md)

## Security checklist

Run through this whenever you write or review a contract. Details, wrong/right code and sources are in [references/security.md](references/security.md).

1. **No JS control flow on provable values.** `if (bool)` is always true. `toBoolean()`, `toBigInt()` and `Number()` throw in circuits. Use `Provable.if` and assertions.
2. **Witnesses are hints, not checks.** Code inside `Provable.witness` or `Provable.asProver` is not proven. Constrain every witnessed value afterwards.
3. **Assert every comparison.** `equals()` and `lessThan()` return a `Bool` that constrains nothing until asserted.
4. **State reads use `getAndRequireEquals()`.** Never silence the precondition error with `requireNothing()`.
5. **Authenticate callers with `this.sender.getAndRequireSignature()`.** `getUnconstrained()` lets the prover pick any sender.
6. **Verify every proof argument and pin its public input** to on-chain state (`proof.verify()` plus an assertion).
7. **Bind Merkle witnesses** to the on-chain root and to the expected key or index.
8. **Lock down permissions explicitly.**
   - `setVerificationKey` and `setPermissions` default to `signature`, so the deployer key can replace the code.
   - Token contracts need `access: proof()`.
   - Never `allImpossible()` on an account that must send or receive.
9. **Signed messages need domain separation.** Include the contract address, a nonce, the action and the network in the message; `Signature.verify` itself is network-agnostic.
10. **Use `UInt64` for amounts, never `Field`.** Field arithmetic wraps around the modulus, and `Field.div` is modular inversion.
11. **`Provable.if` evaluates both branches.** Make the unselected branch safe too, for example by avoiding division by zero.
12. **Know the reducer limits.**
    - At most `maxUpdatesWithActions` (default 32) pending updates.
    - At most `maxActionsPerUpdate` (default 1) actions per update.
    - Validate when dispatching, never inside the reduce callback.
13. **Hash variable-length data with `Poseidon.hashAnyLength`.** `Poseidon.hash([x])` equals `Poseidon.hash([x, 0])`.

## Agent guardrails

- **Private keys:**
  - Never ask the user to paste a private key into the chat, and never print one.
  - Read keys from environment variables or files the user controls.
  - The zkApp key controls upgrades; tell the user to back it up.
- **Networks:**
  - Default to `LocalBlockchain`, lightnet or devnet.
  - Use mainnet only when the user asks for it explicitly.
  - Before sending a mainnet transaction, show the network, fee payer, every account update and any amounts, and wait for confirmation.
- **Irreversible permissions:**
  - Never upgrade by calling `deploy()` again.
  - Never set `impossible` permissions without stating that they cannot be undone (the only exception: after a hard fork, `setVerificationKey` and `access: proof` temporarily accept a signature, see [references/mesa.md](references/mesa.md)).

## References

| File | Read it when |
|---|---|
| [migration.md](references/migration.md) | Code or docs written for o1js 0.x–2.x; every removed or renamed API |
| [mesa.md](references/mesa.md) | Deploying or upgrading on mainnet after 2026-09-03; known documentation bugs |
| [contracts.md](references/contracts.md) | State, methods, events, preconditions, sender, deploy, permissions, time |
| [provable-code.md](references/provable-code.md) | Field/Bool/UInt types, witnesses, conditionals, loops, hashing, foreign curves |
| [transactions.md](references/transactions.md) | Transaction flow, fees, the 16-segment limit, account creation, networks, fetching |
| [zkprogram.md](references/zkprogram.md) | ZkProgram, recursion, verifying proofs in contracts, caching, native prover |
| [actions-and-offchain-state.md](references/actions-and-offchain-state.md) | Concurrent users, actions/reducer, BatchReducer, OffchainState |
| [tokens.md](references/tokens.md) | Custom tokens, `approveBase`, minting, token accounts |
| [security.md](references/security.md) | Writing or reviewing anything that holds value |
| [frontend.md](references/frontend.md) | Browser UIs: Web Worker + Comlink, COOP/COEP headers, connecting a wallet and sending transactions |
| [testing.md](references/testing.md) | Project setup, tsconfig, test structure, constraint counts |
| [errors.md](references/errors.md) | Decoding an error message |
