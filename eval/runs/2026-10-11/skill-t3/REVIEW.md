# Security review: `src/Vault.ts` (o1js 3.1.0, Mina mainnet)

**Verdict: do not deploy.** Any account can empty the vault in a single transaction (finding 1). There are two more independent ways to drain it (2 and 3), and the holder of the zkApp key can take everything at any time (4). Once those holes are closed, the vault as written has no usable withdrawal path, so deposits would be locked forever (5).

| # | Line(s) | Issue | Severity |
|---|---|---|---|
| 1 | 52 (with 53) | The secret check is never asserted, so anyone can withdraw everything | Critical |
| 2 | 33 | `setOwner` trusts `getUnconstrained()`, so anyone can become owner | Critical |
| 3 | 58 | The owner approval signature can be replayed and is not bound to anything | Critical |
| 4 | 25–28 | Permissions let the zkApp key drain funds or replace the contract | High |
| 5 | 18–19, 23–29 | `owner` and `secretHash` are never initialized | High |
| 6 | 49–50 | `requireNothing()` makes the pause check meaningless, and nothing can set `paused` | High |
| 7 | 40–42, 45, 53, 59 | `totalDeposits` accounting is wrong: a JS `if` on a `Bool`, a caller-chosen bonus, no decrement | Medium |
| 8 | 63 | `checkSolvency` always passes: Field arithmetic wraps and the inputs are chosen by the prover | Medium |
| 9 | 38, 45 | Every deposit needs an exact match on `totalDeposits`, so deposits can be griefed | Low |

---

## 1. The secret check is never asserted: anyone can drain the vault (Critical)

**Line 52** (paid out on line 53)

```ts
Poseidon.hash([secret]).equals(expected);   // returns a Bool that is thrown away
this.send({ to: this.sender.getAndRequireSignature(), amount });
```

`equals()` only returns a `Bool`. Nothing asserts it, so the circuit accepts any `secret`.

**Attack:** Any account calls `withdrawWithSecret(<vault balance>, Field(0))` and signs as itself. The proof verifies, and the whole balance is sent to the attacker in one transaction. `amount` has no upper bound, and nothing is subtracted from `totalDeposits`.

**Fix:**
```ts
Poseidon.hashWithPrefix('vault:secret:v1', [secret]).assertEquals(expected);
```
- Use a high-entropy secret, for example `Field.random()` generated off-chain. `secretHash` is public state, so a short or human-chosen secret can be brute-forced offline.
- This is still a bearer credential: whoever learns the secret can withdraw any amount, any number of times. If it is meant to be used once, consume it inside this method (overwrite `secretHash`) and let only the owner set a new one. Also cap `amount` (see finding 7).
- This method only works if `secretHash` is actually set (finding 5).

## 2. Unauthenticated sender in `setOwner`: anyone can take over the vault (Critical)

**Line 33**

```ts
this.sender.getUnconstrained().assertEquals(owner);
```

`getUnconstrained()` is a value the prover supplies; nothing in the proof ties it to the real sender. The check therefore constrains nothing.

**Attack:** The attacker reads `owner` from chain, supplies that key as the "sender" while proving, and calls `setOwner(attackerKey)`. The attacker then signs their own approval and calls `withdrawWithApproval` (line 56) to drain the vault. The legitimate owner is locked out.

**Fix:**
```ts
this.sender.getAndRequireSignature().assertEquals(owner);
```

## 3. The approval signature can be replayed and is not bound to anything (Critical)

**Line 58**

```ts
approval.verify(owner, [amount.value]).assertTrue();
```

The signed message is just the amount. It contains no nonce, recipient, contract address, network, action tag or expiry. In o1js, `Signature.verify` always hashes with the devnet prefix, so the signature carries no network binding either.

**Attack:**
- **Replay:** whoever receives a single approval for `X` can call `withdrawWithApproval(X, sig)` repeatedly until the vault is empty.
- **No recipient binding:** the payout goes to whoever submits the signature, so anyone who sees a leaked or intercepted approval can use it.
- **Cross-context reuse:** any signature the owner ever made over a single field element is also a valid approval for `amount = that value`. That includes signatures for another contract with the same message shape, devnet signatures and generic `signFields([x])` calls.

**Fix:** add a nonce to state and sign a domain-separated message that covers everything the withdrawal depends on:
```ts
const NETWORK_ID = Field(1); // compile-time constant; use a different value for devnet builds

@state(Field) approvalNonce = State<Field>();

@method async withdrawWithApproval(amount: UInt64, expiry: UInt32, approval: Signature) {
  const owner = this.owner.getAndRequireEquals();
  const nonce = this.approvalNonce.getAndRequireEquals();
  const to = this.sender.getAndRequireSignature();
  const message = Poseidon.hashWithPrefix('vault:approve-withdraw:v1', [
    NETWORK_ID,
    ...this.address.toFields(),
    this.tokenId,
    nonce,
    ...to.toFields(),
    amount.value,
    expiry.value,
  ]);
  approval.verify(owner, [message]).assertTrue();
  this.approvalNonce.set(nonce.add(1));
  this.currentSlot.requireBetween(UInt32.zero, expiry);
  this.send({ to, amount });
}
```
With a single nonce, approvals are consumed one at a time and in order. If you need several approvals outstanding at once, track used approvals in a nullifier or Merkle root instead.

## 4. Permissions let the zkApp key drain funds or replace the code (High)

**Lines 25–28**

```ts
this.account.permissions.set({ ...Permissions.default(), send: Permissions.proofOrSignature() });
```

- **`send: proofOrSignature()`:** whoever holds the zkApp private key can sign a plain payment out of the vault, skipping every check in the contract. `Permissions.default()` already uses `proof()` for `send`, so this line deliberately weakens it.
- **Defaults left in place:** `setVerificationKey` and `setPermissions` stay at `signature`. The same key can swap in a different verification key (code that pays the key holder), loosen the permissions, or call `deploy()` again, which resets all permissions to the defaults.
- **Other signature-authorized fields:** `setTiming` and `incrementNonce` also stay at `signature`, so the key holder can, for example, put a vesting schedule on the vault balance and freeze withdrawals.

**Attack:** Anyone who holds the zkApp key, or who compromises it, can take every deposit with one signed transaction. That includes a malicious deployer.

**Fix:** require proofs for funds and state, and lock everything else on purpose:
```ts
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
- **These locks cannot be undone.** `impossible` and `impossibleDuringCurrentVersion()` can only be relaxed through the hard-fork fallback, so even a bug fix cannot be deployed until the next hard fork.
- **If the contract needs to stay upgradable,** use `Permissions.VerificationKey.proofDuringCurrentVersion()` with an owner-gated upgrade `@method` instead. Given how many problems this review found, lock the contract only after the fixed version has been re-audited and tested with proofs enabled.
- **Clients must check the deployed account.** `deploy()` is authorized by signature, so anyone can deploy this same verification key with weak permissions, for example to set up a look-alike vault. Before trusting an address, integrators must check its permissions, its verification-key hash and its initial state.

## 5. `owner` and `secretHash` are never initialized (High)

**Lines 18–19 and 23–29.** The contract has no `init()`, and `deploy()` sets no state. The default `init()` zeroes all state, so `owner` is `PublicKey.empty()`, `secretHash` is `0` and `paused` is `false`. No method ever sets `secretHash`.

**Attack:**
- **With the current code:** the owner role is effectively unclaimed. Any attacker can claim it through finding 2.
- **After findings 1 and 2 are fixed, even without an attacker:**
  - No one can sign for the empty public key, so `setOwner` and `withdrawWithApproval` can never succeed.
  - No one knows a preimage of `0`, so `withdrawWithSecret` can never succeed either.
- **Result:** every deposit is locked permanently. Once finding 4's locked permissions are in place, not even an upgrade can recover them.

**Fix:** set both values at deployment, in the same signed account update that deploys the contract:
```ts
async deploy(args: DeployArgs & { owner: PublicKey; secretHash: Field }) {
  await super.deploy(args);
  this.owner.set(args.owner);
  this.secretHash.set(args.secretHash);
  this.account.permissions.set({ /* see finding 4 */ });
}
```
Another option is a `@method` guarded by `this.account.provedState.requireEquals(Bool(false))` that sets **every** state field. Send it in the same transaction as `deploy()` so it cannot be front-run. After deploying, read back `owner` and `secretHash` and confirm they match what you intended.

## 6. The pause check can be bypassed, and nothing can set `paused` (High)

**Lines 49–50**

```ts
this.paused.requireNothing();
this.paused.get().assertFalse();
```

`requireNothing()` removes the precondition, so the prover can use any value for `paused`. The check only proves "the value I chose is false".

**Attack:** If the vault were ever paused, anyone could keep calling `withdrawWithSecret` by assuming `paused = false`. Today the problem is hidden only because no method can set `paused`; that missing setter is a defect too. The result is that the vault has no working emergency stop. Operators could not halt withdrawals during an incident such as findings 1–3. `withdrawWithApproval` never checks `paused` at all.

**Fix:**
```ts
this.paused.getAndRequireEquals().assertFalse();
```
- Add an owner-only `setPaused(value: Bool)` that authenticates the owner with `getAndRequireSignature()`.
- Apply the same check in `withdrawWithApproval`, and in `deposit` if pausing should also stop deposits.

## 7. `totalDeposits` accounting is wrong (Medium)

**Lines 40–42**

```ts
if (isBonus) { credited = amount.add(UInt64.from(100)); }
```

`isBonus` is a `Bool` object, which is always truthy in JavaScript. The branch is therefore compiled into the circuit unconditionally, and every deposit credits `amount + 100` whatever `isBonus` is. Even written as a provable conditional, the bonus would still be useless as a control, because the caller chooses `isBonus`.

**Lines 53 and 59:** withdrawals never decrease `totalDeposits`.

**Attack:**
- Anyone can push `totalDeposits` up by 100 nanomina per call, even with `amount = 0`, at the cost of the fee alone.
- `totalDeposits` then no longer matches the MINA the vault actually holds.
- Anything that relies on it, such as a solvency check, a UI, an integrator or future share or interest maths, will overstate the vault's liabilities.

**Fix:**
- Remove the caller-controlled bonus. If a bonus is a real requirement, base it on something the caller cannot choose, such as an owner-signed grant, and select it with `Provable.if(isBonus, UInt64, amount.add(bonus), amount)`.
- Reject empty deposits with `amount.assertGreaterThan(UInt64.zero)`.
- Decrease the total in both withdrawals: `this.totalDeposits.set(total.sub(amount))`. `UInt64.sub` throws on underflow, so this also caps withdrawals at the recorded total.

## 8. `checkSolvency` proves nothing (Medium)

**Line 63**

```ts
assets.sub(liabilities).assertGreaterThanOrEqual(Field(0));
```

Field subtraction wraps around the modulus, so `assets - liabilities` is always at least 0 and the assertion can never fail. On top of that, the prover chooses both `assets` and `liabilities`, and neither is tied to state or to the account balance.

**Attack:** Anyone can produce a valid `checkSolvency` transaction for an insolvent vault, for example with `assets = 0` and `liabilities = 10^18`. Any monitor, integrator or other contract that treats a successful call as proof of solvency is misled.

**Fix:** compare on-chain values using `UInt64`:
```ts
@method async checkSolvency() {
  const liabilities = this.totalDeposits.getAndRequireEquals(); // requires the accounting fix in finding 7
  this.account.balance.requireBetween(liabilities, UInt64.MAXINT());
}
```

## 9. Deposit contention and griefing (Low)

**Lines 38 and 45.** Every deposit places an exact-value precondition on `totalDeposits`. Only one deposit can succeed per block, and the others fail with `Account_app_state_precondition_unsatisfied`. A failed zkApp transaction still charges its fee.

**Attack:** An attacker can watch for deposits and front-run each one with a cheap deposit of their own. That changes `totalDeposits`, so the victim's transaction fails and the victim still pays the fee. This blocks deposits for as long as the attacker keeps paying fees.

**Fix:**
- If an on-chain running total is not essential, drop it and treat `this.account.balance` as the source of truth.
- Otherwise, record deposits as actions and fold them in with a reducer or `Experimental.BatchReducer`, and respect the reducer limits.
- At minimum, apply the `amount > 0` check from finding 7.

---

**Before deploying:** apply the fixes and then recompile; the verification key will change. Run the full test suite with `proofsEnabled: true`, including negative tests for every finding above. Then get the result re-reviewed before locking permissions on mainnet.
