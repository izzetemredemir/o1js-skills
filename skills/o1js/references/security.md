# Security pitfalls in o1js contracts

Ordered by severity × how often they show up in real code. Each entry gives the wrong pattern, the fix and a source. **[T]** marks pitfalls reproduced by the tests in [../examples/](../examples/), mostly [pitfalls/Pitfalls.test.ts](../examples/pitfalls/Pitfalls.test.ts) and [token/SimpleToken.test.ts](../examples/token/SimpleToken.test.ts).

Most sources are public audits and the o1js-scan rule set:
- **Audits:** zkSecurity (treasury, Zeko) and Veridise (o1js, fungible token, Lumina, Silvana NFT, FROST multisig).
- **Rule set:** [auditinfra-io/o1js-scan](https://github.com/auditinfra-io/o1js-scan/blob/main/docs/rules.md).

Rule of thumb: a method proves only what its constraints say. Anything computed in plain JavaScript, inside a witness callback, or as an unasserted `Bool` is invisible to the verifier.

## Critical

### 1. JavaScript control flow on provable values [T]
A `Bool` is a JS object, so `if (flag)` is always true and the branch runs regardless of the flag.

In provable code, `toBoolean()`, `toBigInt()`, `toString()` and `Number(x)` throw. Models "fix" that error by moving the logic into `Provable.asProver`, which removes it from the proof. Loops bounded by a witnessed value or indexing with `Number(i.toBigInt())` compile to zero constraints.

```ts
// WRONG
if (isAdmin) this.x.set(v);
if (amount.toBigInt() > 10n) { ... }
for (let i = 0; i < Number(n.toBigInt()); i++) { ... }

// RIGHT
this.x.set(Provable.if(isAdmin, v, this.x.getAndRequireEquals()));
amount.assertGreaterThan(UInt64.from(10));
for (let i = 0; i < MAX; i++) {
  const active = UInt32.from(i).lessThan(n);
  acc = Provable.if(active, acc.add(xs[i]), acc);
}
// conditional assertion: "if isMint then amount <= cap"
isMint.not().or(amount.lessThanOrEqual(cap)).assertTrue();
```

A JS `if` on a compile-time constant (a plain `const NETWORK = 'mainnet'`) is fine; it just picks which circuit gets compiled.

Sources: [Mina docs, secure zkApps](https://docs.minaprotocol.com/zkapps/writing-a-zkapp/introduction-to-zkapps/secure-zkapps); o1js-scan `O1JS_LOGIC_OUTSIDE_PROOF`, `O1JS_CONDITIONAL_ASSERT`.

### 2. Witnesses used as checks
`Provable.witness` and `Provable.asProver` callbacks run only on the prover's machine. A check inside them can simply be deleted by an attacker, and a witnessed value proves nothing until constrained.

```ts
// WRONG
Provable.witness(Bool, () => { if (!sig.verify(pk, msg).toBoolean()) throw Error('bad'); return Bool(true); });
const amount = Provable.witness(UInt64, () => offchainAmount);
this.send({ to, amount });

// RIGHT: witness is a hint; constrain it outside the callback
sig.verify(pk, msg).assertTrue();
const q = Provable.witness(UInt64, () => a.div(b));
const r = Provable.witness(UInt64, () => a.mod(b));
q.mul(b).add(r).assertEquals(a);
r.assertLessThan(b);
```

Sources: [zkSecurity, under-constrained bugs](https://blog.zksecurity.xyz/posts/underconstrain-bugs/); o1js-scan `O1JS_UNCONSTRAINED_PROVABLE_WITNESS`.

### 3. State read without a precondition [T]
A contract whose method calls a bare `get()` fails to compile, and the transaction fails to build ("You used `this.x.get()` without adding a precondition…"). The dangerous "fix" is `requireNothing()`: the prover can then use any value as the current state.

```ts
// WRONG
this.paused.requireNothing();
this.paused.get().assertFalse();

// RIGHT
this.paused.getAndRequireEquals().assertFalse();
```

Source: o1js-scan `O1JS_MISSING_STATE_PRECONDITION`.

### 4. Unauthenticated sender [T]
Mina has no `msg.sender`. `this.sender.getUnconstrained()` is whatever the prover says.

```ts
// WRONG
this.sender.getUnconstrained().assertEquals(admin);
// RIGHT
this.sender.getAndRequireSignature().assertEquals(this.admin.getAndRequireEquals());
```

Sources: [o1js#1425](https://github.com/o1-labs/o1js/issues/1425); Veridise Lumina V-LUM-VUL-009. Test: `rejects minting by anyone else`.

### 5. Proof arguments not verified, or their inputs not pinned [T]
A `Proof` parameter does nothing until `.verify()` is called. Even then, its public input must be tied to on-chain state, or old or unrelated proofs can be replayed.

In recursion:
- **Base case:** pin the starting values (index = 0, empty root, flags false) instead of taking them from the public input.
- **Merge step:** link `left.publicOutput` to `right.publicInput`.

```ts
// WRONG
@method async settle(p: MyProof) { this.root.set(p.publicOutput.root); }

// RIGHT
@method async settle(p: MyProof) {
  p.verify();
  p.publicInput.root.assertEquals(this.root.getAndRequireEquals());
  this.root.set(p.publicOutput.root);
}
// merge: left.publicOutput.target.assertEquals(right.publicInput.source);
```

Sources:
- [zkSecurity treasury report](https://reports.zksecurity.xyz/reports/mina-treasury-1.md): four High findings.
- [zkSecurity Zeko report](https://reports.zksecurity.xyz/reports/zeko.md): unlinked merge.
- o1js-scan `O1JS_UNVERIFIED_PROOF`.
- Test: [SumProgram.test.ts](../examples/zkprogram/SumProgram.test.ts) `refuses a chain that does not start from the on-chain total`.

### 6. Merkle witnesses not bound to the root or index
```ts
// WRONG: root or index chosen by the prover
witness.calculateRoot(leaf).assertEquals(claimedRoot);

// RIGHT
witness.calculateRoot(leaf).assertEquals(this.root.getAndRequireEquals());
witness.calculateIndex().assertEquals(expectedIndex);
const [root, key] = mapWitness.computeRootAndKey(value);
root.assertEquals(this.root.getAndRequireEquals());
key.assertEquals(expectedKey);
```

A custom `MerkleWitness(256)` keyed by hashes lets `k` and `k + p` alias. The treasury audit found this enabled double voting. Keep the height ≤ 255.

Sources: treasury "Index aliasing" (High); Veridise o1js V-O1J-VUL-002; o1js-scan `O1JS_STALE_MERKLE_ROOT`.

### 7. Weak or accidental permissions [T]
`Permissions.default()`:
- `editState`, `send`, `editActionState`: `proof`
- `receive`, `access`: `none`
- **everything else, including `setVerificationKey` and `setPermissions`: `signature`**

So by default whoever holds the zkApp key can replace the contract's code and permissions.

Three related traps:
- **`deploy()` is signature-authorized, not proved.** Anyone can deploy your verification key with different permissions or initial state, so a matching verification key does not prove an account is genuine. Clients must check the whole permission set and initial state.
- **Calling `deploy()` again resets every permission to the defaults** [T: [Upgradable.test.ts](../examples/upgrade/Upgradable.test.ts)].
- **`Permissions.allImpossible()` also blocks `send` and `receive`.** The account is bricked forever.

```ts
// A locked-down contract. Decide consciously about setVerificationKey:
// impossibleDuringCurrentVersion() = immutable until the next hard fork;
// proofDuringCurrentVersion()      = upgradable only through a method you write and govern.
this.account.permissions.set({
  ...Permissions.default(),
  editState: Permissions.proof(),
  send: Permissions.proof(),
  setVerificationKey: Permissions.VerificationKey.impossibleDuringCurrentVersion(),
  setPermissions: Permissions.impossible(),
  setZkappUri: Permissions.impossible(),
  setTokenSymbol: Permissions.impossible(),
  setTiming: Permissions.impossible(),
  incrementNonce: Permissions.impossible(),
  setVotingFor: Permissions.impossible(),
});
```

To initialize state with a proof, use a method that checks `this.account.provedState.requireEquals(Bool(false))`, sets **every** state field, and is sent in the **same transaction** as `deploy()`. Otherwise it can be front-run.

Sources:
- [Mina docs](https://docs.minaprotocol.com/zkapps/writing-a-zkapp/introduction-to-zkapps/secure-zkapps).
- Treasury: "Permissions ineffective due to deploy" and "Restrictive permissions prevent operation".
- Veridise Lumina V-LUM-VUL-008; Silvana NFT V-MNFT-VUL-007.
- o1js-scan `O1JS_WEAK_PERMISSIONS`.

### 8. Token approval mistakes [T]
- **`access` must be `proof()`.**
  - With `none`, anyone can mint by creating the token owner's account update directly [T: `LeakyToken`].
  - With `proofOrSignature()` (what `TokenContract.deploy()` sets by default), the token contract's key holder can sign around `approveBase` [T: `KeyHolderToken`]. Veridise V-MIN-VUL-006 flagged this.
- **Spreading `Permissions.default()` after `super.deploy()` resets `access` to `none`.**
- **Never approve a caller-supplied account update without checks,** and never take `isMint` from the caller.
- **Check the running total per update, not just the final sum,** or a flash mint is possible (V-MIN-VUL-002) [T: [StrictToken.test.ts](../examples/token/StrictToken.test.ts)].
- **Keep token holders' `access` and `receive` permissions at `none`.** Otherwise a holder can block transfers.

```ts
// WRONG
@method async approveUpdate(update: AccountUpdate) { this.approve(update); }

// RIGHT: extend TokenContract and implement approveBase
@method async approveBase(forest: AccountUpdateForest) {
  this.checkZeroBalanceChange(forest); // at most TokenContract.MAX_ACCOUNT_UPDATES = 9 updates
}
```

Reference implementation: `internalApproveBase` in [o1-labs-XT/fungible-token-contract](https://github.com/o1-labs-XT/fungible-token-contract). It checks permissions per update and blocks flash mints. Note that it is still on o1js 2.x. Also see [tokens.md](tokens.md).

## High

### 9. Signature replay and missing domain separation
`Signature.create` and `Signature.verify` always hash with the `'devnet'` prefix ([source](https://github.com/o1-labs/o1js/blob/main/src/lib/provable/crypto/signature.ts)), so a signature is valid on every network. Signatures carry no nonce.

```ts
// WRONG
sig.verify(admin, [amount.value]).assertTrue();

// RIGHT
const nonce = this.nonce.getAndRequireEquals();
const message = Poseidon.hashWithPrefix('myapp:withdraw:v1', [
  NETWORK_ID, // a compile-time constant, e.g. Field(1) for mainnet
  ...this.address.toFields(),
  this.tokenId,
  nonce,
  ...to.toFields(),
  amount.value,
  expiry.value,
]);
sig.verify(admin, [message]).assertTrue();
this.nonce.set(nonce.add(1));
this.currentSlot.requireBetween(UInt32.zero, expiry);
```

Rules:
- Use one prefix per action.
- Build messages from `Struct.toFields` rather than hand-written field lists. A hand-written list dropped fields in V-LMN-VUL-002.
- MinaGuard's proposal hash is a good model.

For nullifiers:
- Verify them with `nullifier.verify([message])` and track the used ones in an on-chain root.
- `nullifier.getPublicKey()` deanonymizes the user.

Sources: [o1js#720](https://github.com/o1-labs/o1js/issues/720); treasury "Weak signature binding"; Veridise Lumina V-LUM-VUL-004 and Lumina multisig V-LMN-VUL-001/002.

### 10. Arithmetic: Field wraps, UInt64 throws [T]
- **Field wraps.** `Field(0).sub(1)` is `p - 1`, so `x.sub(y).assertGreaterThanOrEqual(0)` is always true.
- **`Field.div` is modular inversion.** `Field(7).div(2).mul(2)` is 7, and the quotient is not 3.
- **`UInt64` throws on overflow and underflow.** Use it for amounts, but plan for it: in the treasury audit, `supply.mul(bps)` above 2^64 made tallying unprovable. That is a liveness bug.
- **`UInt64.Unsafe.fromField(f)` skips the range check.** `Provable.witness(UInt64, ...)` range-checks.

Sources: Veridise V-O1J-VUL-039; treasury "UInt64 overflow"; Zeko-2 (Field underflow in a quorum check).

### 11. `Provable.if` evaluates both branches [T]
Both arguments are computed and constrained. Consequences:
- A division by zero, `inv`, `sqrt` or `UInt64` underflow in the unselected branch still fails.
- A state write in either argument always happens.

```ts
// WRONG: unprovable when d == 0
Provable.if(d.equals(0), Field(0), n.div(d));

// RIGHT
const safe = Provable.if(d.equals(0), Field(1), d);
Provable.if(d.equals(0), Field(0), n.div(safe));
```

Also watch for a `const` declared inside a block shadowing an outer `let`. In Lumina this was Critical: liquidity providers after the first received no LP tokens (V-LUM-VUL-001).

Sources: Veridise V-O1J-VUL-060; o1js-scan `O1JS_GUARDED_INVERSE`.

### 12. Actions and reducer limits [T]
- **`reduce()` limits.** It handles at most `maxUpdatesWithActions` (default 32) account updates with pending actions, each with at most `maxActionsPerUpdate` (default 1) actions.
  - If anyone floods past that, `reduce` can never be proven again: a permanent denial of service (V-O1J-VUL-005; fungible-token V-MIN-VUL-001).
  - The 3.1 typings call the reducer "not safe to use in production".
- **A method that dispatches twice needs `maxActionsPerUpdate: 2`.** With the default, rollup becomes impossible [T: `reducer pitfall`; working version in [ActionCounter.ts](../examples/reducer/ActionCounter.ts)].
- **Never assert inside the reduce callback.** It also runs on dummy padding entries. Validate when dispatching instead.
- **Reject placeholder values at dispatch.** In the treasury audit, the reducer's dummy value was accepted as a real vote.
- **Prefer `Experimental.BatchReducer` for unbounded action counts.** Its callback receives an `isDummy` flag.

### 13. Hash encoding collisions [T]
`Poseidon.hash` zero-pads, so these collide:
- `[x]` and `[x, 0]`
- `[]`, `[0]` and `[0, 0]`

Flattening variable-length arrays also collides: `{a: [1], b: [2]}` and `{a: [1, 2], b: []}` hash the same.

```ts
Poseidon.hashAnyLength(fields);                              // appends the length (o1js ≥ 2.14)
Poseidon.hashWithPrefix('myapp:purpose', [Field(a.length), ...a, Field(b.length), ...b]);
```

Don't use `Field(0)` to mean "empty".

Sources: Veridise V-O1J-VUL-036/043; [o1js#1428](https://github.com/o1-labs/o1js/issues/1428).

### 14. Unasserted comparisons [T]
`equals`, `lessThan` and friends return a `Bool`. Unless it is asserted, the method accepts anything.

```ts
commitment.equals(preimage.hash());        // WRONG: no constraint
commitment.assertEquals(preimage.hash());  // RIGHT
```

Source: o1js-scan `O1JS_UNASSERTED_BOOL` (real hits in public repos) and `O1JS_VACUOUS_ASSERT` (e.g. `x.assertEquals(x)`).

## Medium

### 15. Concurrency on shared state
Two transactions in the same block that both `getAndRequireEquals()` the same field cannot both succeed. The second fails with `Account_app_state_precondition_unsatisfied`. Cheap preconditions on shared values (like DEX reserves) can be front-run.

Options:
- Per-user token accounts.
- Actions and a reducer ([actions-and-offchain-state.md](actions-and-offchain-state.md)).
- A sequencer.
- Bounds (slippage) instead of exact equality.

`Experimental.OffchainState` caveats:
- `overwrite()` races.
- An `update({ from, to })` whose `from` no longer matches is **silently dropped**, so never tie a payment to it **[T: [OffchainLedger.test.ts](../examples/offchain-state/OffchainLedger.test.ts)]**.

### 16. Precondition and state semantics [T]
- **No read-your-write.** `get()` after `set()` in the same method returns the old value; keep the new value in a local variable.
- **Set each precondition exactly once per account update, in one place.** In o1js 3.1 the consistency check for repeated range preconditions compares the old upper bound with the new *lower* bound (`precondition.ts`). As a result:
  - Repeating an identical `requireBetween(0, 1000)` throws `Field.assertEquals(): 1000 != 0`.
  - `requireBetween(0, 0)` followed by `requireBetween(0, 1000)` is accepted, and the last, wider range wins.

  Reproduced on 3.1.0; not yet reported upstream as of 2026-10-11.

### 17. Time and slots
- **Use `this.currentSlot.requireBetween(lo, hi)` for deadlines.** `this.network.globalSlotSinceGenesis` refers to the previous block (treasury, Low).
- **Mesa halved the slot time to 90 s.** Durations hard-coded as slot counts now pass twice as fast in wall-clock time.
- **`network.timestamp` preconditions bake the genesis timestamp into the circuit,** so the verification key differs per network ([o1js#1588](https://github.com/o1-labs/o1js/issues/1588)).

### 18. Accounts and fees [T]
- **Identity:** an account is `(publicKey, tokenId)`. Comparing public keys alone confused accounts in the treasury and Zeko audits.
- **Creating an account:**
  - Even a `none`-authorized account update can create an account; use `account.isNew.requireEquals(Bool(true))` where creation must happen once.
  - New accounts, including token accounts, need `AccountUpdate.fundNewAccount(feePayer, n)`, or the transaction fails with "Invalid fee excess".

### 19. Trust model
- **Every compiled `@method` can be called by anyone.** A "disabled" code path must be asserted off in the circuit.
- **`provedState` means little if the verification key can be swapped:** swap the key, change state, swap back.
- **Configuration the prover chooses** (`Provable.witness(Bool, () => isMainnet)`) is attacker-controlled. Use compile-time constants (V-MNFT-VUL-020).
- **Only call external contracts whose verification key and permissions are locked.**

### 20. Privacy
- `@method` arguments stay private, but state, events, actions, the memo and nullifier public keys are public.
- Never emit secrets; commit to `Poseidon.hash([secret, salt])` instead.
- `Encryption`: Veridise V-O1J-VUL-009 found the 1.x scheme malleable. Since 2.0 `encrypt`/`decrypt` add and check an authentication tag. Still, don't treat it as a vetted encryption standard; prefer commitments where you can.

## Low (but confusing)

- **Randomness in a witness** (`Field.random()`, `Math.random()`, `Date.now()`): the method runs more than once while proving, so this causes constraint failures. Pass randomness in as an argument.
- **`MerkleList`:** iterate and then call `assertAtEnd()` (V-MIN-VUL-011).
- **Missing `await`** on a contract call inside a transaction: if the method awaits anything internally, its account update is silently left out. The transaction sends without it, and an "inconsistent state" error surfaces later. Await every call and lint for floating promises.
- **Two copies of o1js in one app** cause bizarre type and runtime errors; dedupe dependencies.
- **Tooling:** run [o1js-scan](https://github.com/auditinfra-io/o1js-scan) in CI for many of the patterns above. Don't copy its `examples/safe_vault.ts`, which still lets anyone withdraw everything.
