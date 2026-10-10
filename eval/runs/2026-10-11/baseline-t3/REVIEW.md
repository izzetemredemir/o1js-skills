# Security review: `src/Vault.ts` (o1js 3.1.0, Mina mainnet)

**Verdict: do not deploy.** Two separate Critical bugs each let anyone take every MINA in the vault without needing any key.

## Summary

| # | Line(s) | Issue | Severity |
|---|---------|-------|----------|
| 1 | 33 | `setOwner` checks an unconstrained sender, so anyone can become owner | Critical |
| 2 | 52 | Secret check result is thrown away, so any secret lets you withdraw any amount | Critical |
| 3 | 58 | Owner approval signature can be replayed and is not tied to recipient, nonce or contract | High |
| 4 | 25-28 | zkApp private key can bypass the contract (`send: proofOrSignature`, VK and permissions changeable by signature) | High |
| 5 | 49-50 | `paused` is read with no precondition, so the pause can be bypassed | Medium |
| 6 | 23-29 (and contract-wide) | `owner` and `secretHash` are never set, and nothing can set `secretHash` or `paused` | Medium |
| 7 | 40-41 | `if (isBonus)` on a provable `Bool` is always true; anyone can inflate `totalDeposits` | Medium |
| 8 | 38, 45 | Exact-value precondition on a global counter lets one user block everyone's deposits | Medium |
| 9 | 63 | `checkSolvency` always passes (Field arithmetic wraps) and its inputs are made up by the caller | Low |

---

## 1. `setOwner` trusts an unconstrained sender: anyone becomes owner (line 33)

```ts
this.sender.getUnconstrained().assertEquals(owner);
```

**Problem.** `this.sender.getUnconstrained()` is a plain witness. The circuit does not tie it to the transaction's fee payer, and no signature is required from that key. The zkApp proof also does not cover the fee payer. So the prover can put any public key there.

**Attack.** The attacker builds `Mina.transaction({ sender: <current owner>, fee }, () => vault.setOwner(attacker))` and runs `tx.prove()`. They then replace the fee payer with their own account and sign it. Patching the witness directly also works. After deployment `owner` is `PublicKey.empty()` (see #6), so the attacker does not even need to know who the owner is. Once owner, they sign approvals for themselves and drain the vault through `withdrawWithApproval` (line 56).

**Severity.** Critical: anyone can take over the contract and steal all funds.

**Fix.** Make the sender sign:
```ts
const owner = this.owner.getAndRequireEquals();
this.sender.getAndRequireSignature().assertEquals(owner);
// or: AccountUpdate.createSigned(owner);
```
Also reject an empty new owner: `newOwner.isEmpty().assertFalse();`.

## 2. Secret check is never asserted: anyone can drain (line 52)

```ts
Poseidon.hash([secret]).equals(expected);   // returns a Bool that is discarded
```

**Problem.** `.equals()` only computes a `Bool`. It adds no constraint, so the hash comparison never runs.

**Attack.** Anyone calls `withdrawWithSecret(<full balance>, Field(0))` with any secret and takes the whole balance in one transaction.

**Severity.** Critical.

**Fix.**
```ts
Poseidon.hash([secret]).assertEquals(expected);
```
Even with this fix, the design is weak. One shared secret is a bearer credential for the whole balance: there is no limit per withdrawal, no nullifier, and no binding to a user. Anyone who ever learns it can drain the vault, and a low-entropy secret can be brute-forced offline against the public `secretHash`. Use per-claim commitments with nullifiers, or remove this path.

## 3. Approval signature can be replayed and is not bound to anything (line 58)

```ts
approval.verify(owner, [amount.value]).assertTrue();
```

**Problem.** The signed message is only `[amount]`. It contains no nonce, no recipient, no contract address and no domain or network tag, and the contract keeps no record of used approvals.

**Attack.**
- The owner approves 10 MINA for Alice once. Alice, or anyone who obtains the signature (for example from logs or a backend), can call `withdrawWithApproval(10 MINA, sig)` again and again, sending 10 MINA to themselves each time until the vault is empty.
- The recipient is whoever sends the transaction, so a leaked signature can be redirected to any account.
- Any signature the owner key produces over a single field, in another app or another Vault deployment, counts as an approval for that value.

**Severity.** High. After the first legitimate approval, the holder of that signature can drain the vault.

**Fix.** Store a nonce, sign a message that binds every relevant value, and increment the nonce on use:
```ts
const nonce = this.approvalNonce.getAndRequireEquals();
const recipient = this.sender.getAndRequireSignature();
approval.verify(owner, [
  APPROVAL_TAG,              // constant, different per network/app
  ...this.address.toFields(),
  ...recipient.toFields(),
  amount.value,
  nonce,
]).assertTrue();
this.approvalNonce.set(nonce.add(1));
this.send({ to: recipient, amount });
```

## 4. zkApp private key can bypass all contract logic (lines 25-28)

```ts
...Permissions.default(),
send: Permissions.proofOrSignature(),
```

**Problem.** `send: proofOrSignature()` lets a transaction signed with the zkApp account key move funds without running any method. `Permissions.default()` also leaves `setVerificationKey`, `setPermissions` and `setTiming` at `signature`. Even if `send` were `proof()`, the key holder could change permissions back, or swap in a new verification key that lets them write any state or send any balance.

**Attack.** The deployer, or anyone who steals or leaks the zkApp key, signs a payment out of the vault and takes everything. They can also rewrite the contract, reset `owner`, or lock funds with a timing schedule. The `owner` and secret checks do not protect funds from this key.

**Severity.** High. Funds are effectively custodial to one hot key, and users cannot verify otherwise.

**Fix.**
```ts
this.account.permissions.set({
  ...Permissions.default(),
  send: Permissions.proof(),
  editState: Permissions.proof(),
  setVerificationKey: Permissions.VerificationKey.impossibleDuringCurrentVersion(),
  // or proofDuringCurrentVersion() plus an owner-gated upgrade @method
  setPermissions: Permissions.impossible(),
  setTiming: Permissions.impossible(),
});
```
After a hard fork that bumps the transaction version, `*DuringCurrentVersion` falls back to `signature`. Keep the zkApp key in cold storage accordingly.

## 5. Pause flag is read without a precondition and can be bypassed (lines 49-50)

```ts
this.paused.requireNothing();
this.paused.get().assertFalse();
```

**Problem.** `requireNothing()` explicitly turns off the on-chain precondition. The value from `get()` is a prover-supplied witness that the network never checks against the account's real state.

**Attack.** While the vault is paused, an attacker proves against a local, stale or forged copy of the account where `paused = false`. The network accepts the transaction and the withdrawal goes through. The emergency stop does nothing. `withdrawWithApproval` (lines 56-60) has no pause check at all.

**Severity.** Medium. The security control is broken; today there is also no way to set `paused` (see #6).

**Fix.**
```ts
this.paused.getAndRequireEquals().assertFalse();
```
Add the same check to `withdrawWithApproval`, and add an owner-gated `setPaused` method.

## 6. Owner and secret are never initialised; `secretHash` and `paused` cannot be set (lines 23-29, contract-wide)

**Problem.** `deploy()` sets only permissions. The default `init()` zeroes all app state, so `owner = PublicKey.empty()`, `secretHash = 0` and `paused = false`. No method ever writes `secretHash` or `paused`, and `editState` is `proof`, so they can never change.

**Attack / impact.**
- An empty owner is what makes #1 trivial.
- Once #1 is fixed with a real signature check, nobody can ever act as owner. `setOwner` and `withdrawWithApproval` become permanently unusable.
- `withdrawWithSecret` can only be used through bug #2.
- The pause can never be turned on.

**Severity.** Medium.

**Fix.** Set `owner` and `secretHash` at deploy time (see the sketch below). Add owner-gated `setSecretHash` and `setPaused` methods, both using `getAndRequireEquals()` on `owner` and `this.sender.getAndRequireSignature()`.

## 7. `if (isBonus)` on a provable `Bool` is always true; deposit accounting can be inflated (lines 40-41)

```ts
if (isBonus) { credited = amount.add(UInt64.from(100)); }
```

**Problem.**
- `isBonus` is a JS object, which is always truthy. The branch is fixed into the circuit at compile time, so every deposit credits `amount + 100` whatever value is passed.
- Even with a correct conditional, the caller chooses the bonus, so it is unbacked credit anyone can claim.
- `amount = 0` is accepted.
- Withdrawals never reduce `totalDeposits`.

**Attack.** Anyone calls `deposit(0, …)` repeatedly. Each call adds 100 nanomina to `totalDeposits` without paying. The on-chain accounting then no longer matches the balance, which corrupts anything that relies on it: UIs, off-chain solvency reports, or a future fixed `checkSolvency`.

**Severity.** Medium.

**Fix.** Remove the caller-controlled bonus and require `amount.assertGreaterThan(UInt64.from(0))`. If a bonus is a real requirement, make it owner-authorised and use `Provable.if(isBonus, amount.add(100), amount)` instead of a JS `if`. Decide whether `totalDeposits` is a lifetime counter or outstanding liabilities. If it is liabilities, reduce it on withdrawal.

## 8. Global-counter precondition lets one user block deposits (lines 38, 45)

**Problem.** Every `deposit` adds an exact-value precondition on `totalDeposits`. Only one deposit per block can succeed. The others fail with `Account_app_state_precondition_unsatisfied` and still pay their fee.

**Attack.** An attacker sends a cheap `deposit(0, …)` with a higher fee each block. Their transaction is applied first, and every honest deposit in that block fails. Normal traffic causes the same failures without any attacker.

**Severity.** Medium (availability).

**Fix.** Do not keep a hot global counter updated by an exact-match precondition. Either emit actions and fold them with a `Reducer` in a separate settle method, or drop the on-chain counter and index deposits off-chain. Requiring `amount > 0` (#7) makes the grief cost real MINA but does not remove the contention.

## 9. `checkSolvency` always passes and proves nothing (line 63)

```ts
assets.sub(liabilities).assertGreaterThanOrEqual(Field(0));
```

**Problem.**
- `Field` subtraction wraps modulo p, and every field element is ≥ 0, so the assertion is always true. For example, `liabilities > assets` gives `p - (liabilities - assets)`, which still passes.
- Both inputs are private values the caller chooses and are not linked to the account balance or state.

**Attack.** Anyone can produce a "successful" solvency-check transaction for any numbers. If an operator, UI or auditor treats it as proof of reserves, they are misled.

**Severity.** Low (no direct fund loss; higher if anything relies on it).

**Fix.** Remove the method, or link it to on-chain values and use range-checked types:
```ts
@method async checkSolvency() {
  const liabilities = this.totalDeposits.getAndRequireEquals(); // must track outstanding liabilities, see #7
  this.account.balance.requireBetween(liabilities, UInt64.MAXINT());
}
```

---

## Remediation sketch (combines fixes 1-7)

```ts
import {
  AccountUpdate, Bool, DeployArgs, Field, Permissions, Poseidon,
  PublicKey, Signature, SmartContract, State, UInt64, method, state,
} from 'o1js';

const APPROVAL_TAG = Field(0x5641554c54); // pick a distinct value per network/deployment

type VaultDeployArgs = DeployArgs & { owner: PublicKey; secretHash: Field };

export class Vault extends SmartContract {
  @state(PublicKey) owner = State<PublicKey>();
  @state(Field) secretHash = State<Field>();
  @state(UInt64) totalDeposits = State<UInt64>();
  @state(Bool) paused = State<Bool>();
  @state(Field) approvalNonce = State<Field>();

  async deploy(args: VaultDeployArgs) {
    await super.deploy(args);
    this.owner.set(args.owner);
    this.secretHash.set(args.secretHash);
    this.account.permissions.set({
      ...Permissions.default(),
      send: Permissions.proof(),
      editState: Permissions.proof(),
      setVerificationKey: Permissions.VerificationKey.impossibleDuringCurrentVersion(),
      setPermissions: Permissions.impossible(),
      setTiming: Permissions.impossible(),
    });
  }

  private requireOwner() {
    const owner = this.owner.getAndRequireEquals();
    this.sender.getAndRequireSignature().assertEquals(owner);
    return owner;
  }

  @method async setOwner(newOwner: PublicKey) {
    this.requireOwner();
    newOwner.isEmpty().assertFalse();
    this.owner.set(newOwner);
  }

  @method async setSecretHash(newHash: Field) {
    this.requireOwner();
    this.secretHash.set(newHash);
  }

  @method async setPaused(p: Bool) {
    this.requireOwner();
    this.paused.set(p);
  }

  // See #8: for real throughput, replace the counter with actions + Reducer.
  @method async deposit(amount: UInt64) {
    amount.assertGreaterThan(UInt64.from(0));
    const total = this.totalDeposits.getAndRequireEquals();
    const payer = AccountUpdate.createSigned(this.sender.getAndRequireSignature());
    payer.send({ to: this.address, amount });
    this.totalDeposits.set(total.add(amount));
  }

  @method async withdrawWithSecret(amount: UInt64, secret: Field) {
    this.paused.getAndRequireEquals().assertFalse();
    const expected = this.secretHash.getAndRequireEquals();
    Poseidon.hash([secret]).assertEquals(expected);
    this.send({ to: this.sender.getAndRequireSignature(), amount });
  }

  @method async withdrawWithApproval(amount: UInt64, approval: Signature) {
    this.paused.getAndRequireEquals().assertFalse();
    const owner = this.owner.getAndRequireEquals();
    const nonce = this.approvalNonce.getAndRequireEquals();
    const recipient = this.sender.getAndRequireSignature();
    approval
      .verify(owner, [
        APPROVAL_TAG,
        ...this.address.toFields(),
        ...recipient.toFields(),
        amount.value,
        nonce,
      ])
      .assertTrue();
    this.approvalNonce.set(nonce.add(1));
    this.send({ to: recipient, amount });
  }

  // checkSolvency removed: see #9.
}
```

Before mainnet, add negative tests on `LocalBlockchain` for each finding:
- a non-owner calls `setOwner`
- a wrong secret is used
- an approval is replayed or redirected to another recipient
- a withdrawal is attempted while paused
- a signature-only `send` from the zkApp key
