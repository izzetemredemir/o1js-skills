# Migrating to o1js 3.1

Changes that affect app developers, from o1js 0.18 to 3.1.0, grouped by area. **[T]** means a test in [../examples/](../examples/) reproduces it on 3.1.0; everything else comes from the [o1js CHANGELOG](https://github.com/o1-labs/o1js/blob/main/CHANGELOG.md) and the 3.1.0 typings.

Versions:
- `npm view o1js version` → 3.1.0. The `experimental` dist-tag still points at `3.0.0-mesa.rc2`; never install it.
- 3.0.0 published 2026-08-18; 3.1.0 published 2026-09-23 (the CHANGELOG says 2026-09-21). Since 3.0, o1js requires Node ≥ 22.19.5 (2.x required ≥ 18.14.0).

## Project setup

| Old | New | Since |
|---|---|---|
| `await isReady`, `shutdown()` | Gone. `await initializeBindings()` is optional | 0.18 |
| Top-level await inside o1js | Removed; `await initializeBindings()` is optional. Both ESM and CJS entry points ship (`exports.node.import` / `require`) | 1.0 |
| zkapp-cli template `"o1js": "^2.*"` | Set `"o1js": "^3.1.0"`. zkapp-cli 0.23.0 still scaffolds 2.x | — |
| WASM prover only | `setBackend('native')` before anything initialises o1js (`LocalBlockchain`, `compile`, …), or `O1JS_BACKEND=native`. linux-x64/arm64 and darwin-x64/arm64 only, no Windows, no browser. `setBackend` after bindings are initialised throws | 3.0 |
| Verification-key caches from 2.x | Regenerate; every key changed | 3.0 |

## Smart contracts

| Old | New | Since |
|---|---|---|
| `@method inc() {}` | `@method async inc() {}`, called with `await` **[T]** | 0.18 |
| Methods return nothing | `@method.returns(Field) async f(): Promise<Field>` **[T]** | 0.18 |
| `this.x.assertEquals(v)`, `assertNothing()` (preconditions) | `requireEquals(v)`, `requireNothing()`; `requireEqualsIf(cond, v)` since 1.5 | 0.18 |
| `this.sender` | `this.sender.getAndRequireSignature()` (authenticated) or `this.sender.getUnconstrained()` (prover-chosen) | 0.18 |
| `this.sender.getAndRequireSignatureV2()` (1.7–1.x workaround for a vulnerability in the original) | `this.sender.getAndRequireSignature()`, which is the fixed version since 2.0 | 2.0 |
| `zkApp.deploy({ zkappKey })` | `await zkApp.deploy()`, transaction signed with the fee payer and zkApp keys **[T]** | 0.18 |
| Default state values set in `init()` only | `@state(Field) x = State(Field(1))` is applied by the default `init()` | 1.2 |
| 8 state fields | 32 field elements per account (Mesa) **[T]** | 3.0 |
| 100 field elements of events and 100 of actions per transaction, at most 16 per event | 1024 of each per transaction (separate limits), no per-event cap (Mesa) | 3.0 |
| `emitEvent` only | `emitEventIf(cond, type, value)` | 1.6 |
| A lower method limit | At most 30 methods per SmartContract or ZkProgram (CHANGELOG; not visible in typings) | 2.2 |

## Provable types and in-circuit code

| Old | New | Since |
|---|---|---|
| `Circuit.if`, `Circuit.witness`, `Circuit.*` | `Provable.if`, `Provable.witness`, … | 0.18 |
| `CircuitValue`, `@prop`, `@arrayProp` | `Struct({...})` **[T: not exported]** | 0.18 |
| `Field.isZero()` | `x.equals(0)` **[T]** | 0.18 |
| `UInt64.lt/lte/gt/gte` | `lessThan`, `lessThanOrEqual`, `greaterThan`, `assertLessThan`, … **[T]** | 0.18 |
| `UInt64.from(field)` | `UInt64.Unsafe.fromField(f)` (no range check) or construct from number/bigint | 0.18 |
| `Bool.Unsafe.ofField` | `Bool.Unsafe.fromField` | 0.18 |
| `Provable.witness(Field, () => Field(5))` only | The callback may return plain values (`() => 5n`); a class may be passed instead of `.provable` | 1.0 / 1.6 |
| `Provable.equal(a, b)` | `Provable.equal(Type, a, b)` **[T]** | 2.0 |
| `Provable.if(b, x, y)` with a struct | Write `Provable.if(b, Type, x, y)`: the typings require the type for structs, and plain objects fail at runtime without it | — |
| `Int64` constructor | `Int64.create(magnitude, sign)` or `Int64.from(n)` | 1.5 |
| `divV2`, `modV2`, `isPositiveV2`, `encryptV2`, `Ecdsa.verifyV2`, `createForeignCurveV2`, `computeRootAndKeyV2`, `isUnusedV2` | Plain names; the old algorithms were removed **[T]** | 2.0 |
| `Encryption.encrypt` (1.x algorithm) | Same name, modified algorithm; 1.x ciphertexts are probably incompatible (unverified) | 2.0 |
| `Gadgets.SHA256` | `Hash.SHA2_256.hash(bytes)` or `Gadgets.SHA2.hash(256, bytes)` | 2.3 |
| `Poseidon.hash` for variable-length data | `Poseidon.hashAnyLength` (appends the length; different output) **[T]** | 2.14 |
| `Experimental.IndexedMerkleMap` | Top-level `IndexedMerkleMap`; its root now commits to the length **[T]** | 2.7 |
| `Circuit` (deprecated) | `Experimental.ZkFunction` | 2.8 |
| `Gadgets.inTable` | `RuntimeTable` | 2.10 |
| Bigint conversion | `UInt64`/`UInt8`: `toBigInt()`; `UInt32`/`Int64`: `toBigint()` **[T]** | — |

## Transactions and networks

| Old | New | Since |
|---|---|---|
| `Mina.transaction(feePayerKey, () => {})` | `Mina.transaction(sender | { sender, fee, memo, nonce }, async () => {})` **[T]** | 0.18 |
| `const proofs = await tx.prove()` | `tx.prove()` resolves to the transaction; chaining works: `await Mina.transaction(...).prove().sign([...]).send().wait()` | 1.0 |
| `Mina.LocalBlockchain()` (sync), `testAccounts[i].privateKey` | `await Mina.LocalBlockchain(...)`; test accounts are `TestPublicKey`s with `.key` **[T]** | 1.0 |
| `tx.setFeePerSnarkCost`, `TransactionCost.PROOF_COST/COST_LIMIT/...` | `tx.setFee(UInt64)` / `tx.setFeePerAccountUpdate(n)`; limit is `np + n2 + n1 ≤ 16` segments **[T]** | 2.12 / 3.0 |
| `Mina.accountCreationFee()` | `Mina.getNetworkConstants().accountCreationFee` (1 MINA) | 0.18 |
| `AccountUpdate.createIf(c, pk)` returned an `AccountUpdate` | Returns `OptionalAccountUpdate`; `.value` gives the update, and `approve()` accepts the optional **[T]** | 3.1 |
| `networkId: 'testnet'` | `'devnet'` (`'testnet'` is a deprecated alias). There is no `'mesa'` network id | 2.2 |
| `Mina.Network(url)` assumed mainnet | Defaults to `'devnet'`; pass `networkId: 'mainnet'` **[T]** | — |
| `import { fetchActions } from 'o1js'` | `Mina.fetchActions(...)`; `fetchEvents` remains top-level. `from`/`to` filters and headers since 2.3 **[T]** | — |
| mina-signer 3 (Berkeley format) | mina-signer 4 signs Mesa-format transactions by default; `era: 'berkeley'` for the old format | 3.0 |

## ZkProgram and recursion

| Old | New | Since |
|---|---|---|
| `const proof = await P.m(x)` | `const { proof, auxiliaryOutput } = await P.m(x)` **[T]** | 2.0 |
| Method returns the public output | Method returns `{ publicOutput, auxiliaryOutput? }` **[T]** | 2.0 |
| `P.verify(proof)` used as a boolean | `await P.verify(proof)` **[T]** | — |
| `Proof.fromJSON(json)` sync | `await Proof.fromJSON(json)`; `Proof.dummy` is async too | 1.0 |
| `class P2 extends ZkProgram.Proof(P) {}` only | Also `P.Proof`; `await P.maxProofsVerified()`; `Experimental.Recursive(P)` | 2.2 |
| `analyzeMethods()` sync | `await Contract.analyzeMethods()` | 0.18 |
| Provers take provable values only | Plain JS values are accepted | 2.3 |

## Actions and reducer

| Old | New | Since |
|---|---|---|
| `reduce(...)` returned `{ state, actionState }` | `getActions({ fromActionState })` returns a `MerkleList`; `reduce(list, Type, fn, initial, options)` returns the new state; store `list.hash` as the new action state **[T]** | 1.0 |
| `OffchainState` | Still `Experimental.OffchainState` in 3.1 **[T]** | — |

## Tokens

| Old | New | Since |
|---|---|---|
| `this.token.mint(...)`, `SmartContract.token`, `Token` | `this.internal.mint({ address, amount })`, `.burn`, `.send`; `this.deriveTokenId()`, `TokenId.derive(address)` **[T]** | 0.18 |
| `TokenContractV2` | `TokenContract` **[T]** | 2.0 |
| `TokenContract.deploy()` overwrote permissions set in `init()` | Only upgrades `access` from `none` to `proofOrSignature` and requires `isNew` | 2.13 / 3.0 |

## Permissions and verification keys

| Old | New | Since |
|---|---|---|
| `setVerificationKey: Permissions.impossible()` | `Permissions.VerificationKey.{impossibleDuringCurrentVersion, proofDuringCurrentVersion, signature, proofOrSignature, none}()` **[T]** | 1.2 |
| `VerificationKey.toJSON(vk)` returned a string | Returns `{ data, hash }`; `fromJSON` takes `{ data, hash }` **[T]** | 2.11 / 3.0 |
| Keys compiled with 2.x | Invalid on Mesa; recompile and update with a signed transaction ([mesa.md](mesa.md)) **[T]** | 3.0 |
| Keys compiled with 3.0.x | 3.1.0 changes verification keys (account-update security fixes); recompile every contract and compare `vk.hash` with the on-chain key | 3.1 |

## Still exported but deprecated in 3.1

`Circuit`, `Gadgets.SHA256`, `Gadgets.inTable`, the `Int64` constructor.

## Removed in 3.0

`TransactionCost.{PROOF_COST, SIGNED_PAIR_COST, SIGNED_SINGLE_COST, COST_LIMIT}`, `Transaction.setFeePerSnarkCost`, the Cairo gates (`CairoClaim`, `CairoInstruction`, `CairoFlags`, `CairoTransition`).
