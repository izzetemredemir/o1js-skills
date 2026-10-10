# Concurrency: actions, reducers and off-chain state

## The problem

Every `getAndRequireEquals()` is a precondition on the exact current value. If two users read the same state field and both send a transaction for the same block, the second one fails with `Account_app_state_precondition_unsatisfied`. The more popular a contract, the worse this gets.

Options, from simplest to most capable:

| Approach | When |
|---|---|
| Per-user accounts (token accounts) | Balances and other per-user data; no shared state at all |
| Actions + `Reducer` | Small apps; a bounded number of pending actions between rollups |
| `Experimental.BatchReducer` | Unbounded action counts, processed in fixed-size batches with recursive proofs |
| `Experimental.OffchainState` | Key/value maps and fields too large for 32 on-chain field elements, with concurrent writes |
| An app-specific sequencer or L2 | High throughput |

## Actions and the reducer

Dispatching an action never conflicts with other users. Anyone can later call a rollup method that folds pending actions into state.

Tested example: [ActionCounter.ts](../examples/reducer/ActionCounter.ts), [ActionCounter.test.ts](../examples/reducer/ActionCounter.test.ts).

```ts
export class ActionCounter extends SmartContract {
  reducer = Reducer({ actionType: Field });

  @state(Field) counter = State<Field>();
  @state(Field) actionState = State<Field>();

  init() {
    super.init();
    this.counter.set(Field(0));
    this.actionState.set(Reducer.initialActionState);   // required starting point
  }

  @method async increment() {
    this.reducer.dispatch(Field(1));                    // validate inputs here, at dispatch time
  }

  @method async rollup() {
    const counter = this.counter.getAndRequireEquals();
    const actionState = this.actionState.getAndRequireEquals();
    const pending = this.reducer.getActions({ fromActionState: actionState });  // a MerkleList
    const next = this.reducer.reduce(pending, Field, (total, action) => total.add(action), counter, {
      maxUpdatesWithActions: 8,   // default 32
      maxActionsPerUpdate: 2,     // default 1: must be >= the number of dispatches in any one method
    });
    this.counter.set(next);
    this.actionState.set(pending.hash);
  }
}
```

### Limits and traps
- **Size limit:**
  - `reduce()` can only process `maxUpdatesWithActions` account updates with pending actions per call, each carrying at most `maxActionsPerUpdate` actions.
  - If more accumulate, the rollup can never be proven again. Anyone can cause this by spamming cheap dispatches.
  - The o1js 3.1 typings call the reducer "not safe to use in production" for this reason.
- **A method that dispatches twice needs `maxActionsPerUpdate: 2`.** With the default of 1, rollup becomes impossible **[T: [Pitfalls.test.ts](../examples/pitfalls/Pitfalls.test.ts) `reducer pitfall`]**.
- **The reduce callback also runs on dummy padding entries.** An assertion inside it fails even with real pending actions. Keep the callback pure and validate at dispatch.
- **Reject values that look like the padding,** such as zero or the type's empty value, if they could be misread as real actions.
- **The action-state precondition accepts any of the last few action states.** Make sure state transitions are unique.
- **Don't create account updates for arbitrary accounts inside a reducer.** Their permissions can block the whole rollup.
- **Live networks read actions from the archive node** (`Mina.fetchActions`). A lagging or gappy archive yields a wrong action list ([o1js#2905](https://github.com/o1-labs/o1js/issues/2905), open).

## BatchReducer (experimental)

It processes any number of pending actions in fixed-size batches, one transaction per batch, each with a recursive proof covering the pending actions. Its callback receives an `isDummy` flag.

Tested example: [BatchTotal.ts](../examples/batch-reducer/BatchTotal.ts), [BatchTotal.test.ts](../examples/batch-reducer/BatchTotal.test.ts). Seven deposits are processed as three batches of three **[T]**.

```ts
const { BatchReducer } = Experimental;
export const batchReducer = new BatchReducer({
  actionType: UInt64,
  batchSize: 3,
  maxUpdatesPerProof: 4,     // see the warning below
  maxUpdatesFinalProof: 4,
});
export class Batch extends batchReducer.Batch {}
export class BatchProof extends batchReducer.BatchProof {}

export class BatchTotal extends SmartContract {
  @state(Field) actionState = State(BatchReducer.initialActionState);  // these two names are required
  @state(Field) actionStack = State(BatchReducer.initialActionStack);
  @state(UInt64) total = State(UInt64.zero);

  @method async deposit(amount: UInt64) {
    amount.assertGreaterThan(UInt64.zero);   // validate here: the batch callback also sees dummies
    batchReducer.dispatch(amount);
  }

  @method async process(batch: Batch, proof: BatchProof) {
    let total = this.total.getAndRequireEquals();
    batchReducer.processBatch({ batch, proof }, (amount, isDummy) => {
      total = total.add(Provable.if(isDummy, UInt64.zero, amount));
    });
    this.total.set(total);
  }
}

// setup, outside the contract
batchReducer.setContractClass(BatchTotal);
await batchReducer.compile();          // only when proofs are enabled
await BatchTotal.compile();
batchReducer.setContractInstance(zkApp);

// off-chain: one { batch, proof } per batch of pending actions, then one transaction each
const batches = await batchReducer.prepareBatches();
for (const { batch, proof } of batches) {
  const tx = await Mina.transaction(sender, () => zkApp.process(batch, proof));
  await tx.prove();
  await tx.sign([senderKey]).send();
}
```

**Warning: set `maxUpdatesPerProof` and `maxUpdatesFinalProof` explicitly.** With the defaults (300 and 100), `processBatch` could not be proven in o1js 3.1.0. It fails with `Constraint unsatisfied` while verifying the batch proof. This was reproduced twice, and only shows up with proofs enabled. With 4 and 4 (the values o1js's own tests use) the same test passes **[T]**. Always run BatchReducer code with proofs before deploying.

Rules:
- Never call `processBatch()` on two different batches inside the same method.
- Don't create account updates for arbitrary user accounts inside the callback. A user whose permissions refuse the update deadlocks the reducer; o1js's own airdrop example warns about this.

## OffchainState (experimental)

A Merkle map and fields stored off-chain and committed to on chain. Writes are dispatched as actions and only applied when a `settle` proof is submitted **[T]**.

Tested example: [OffchainLedger.ts](../examples/offchain-state/OffchainLedger.ts), [OffchainLedger.test.ts](../examples/offchain-state/OffchainLedger.test.ts).

```ts
const { OffchainState } = Experimental;

export const offchainState = OffchainState(
  {
    accounts: OffchainState.Map(PublicKey, UInt64),
    totalSupply: OffchainState.Field(UInt64),
  },
  { logTotalCapacity: 10, maxActionsPerProof: 5 }
);
export class StateProof extends offchainState.Proof {}

export class OffchainLedger extends SmartContract {
  @state(OffchainState.Commitments) offchainStateCommitments = offchainState.emptyCommitments();
  offchainState = offchainState.init(this);

  @method async transfer(from: PublicKey, to: PublicKey, amount: UInt64) {
    this.sender.getAndRequireSignature().assertEquals(from);
    const fromOption = await this.offchainState.fields.accounts.get(from);
    const fromBalance = fromOption.assertSome('sender has no account');
    const toOption = await this.offchainState.fields.accounts.get(to);
    // both updates apply together, and only if both values are still what was read here
    this.offchainState.fields.accounts.update(from, { from: fromOption, to: fromBalance.sub(amount) });
    this.offchainState.fields.accounts.update(to, { from: toOption, to: toOption.orElse(0n).add(amount) });
  }

  @method.returns(UInt64) async balanceOf(address: PublicKey) {
    return (await this.offchainState.fields.accounts.get(address)).orElse(0n);
  }

  @method async settle(proof: StateProof) {
    await this.offchainState.settle(proof);
  }
}

// setup and settlement, outside the contract
ledger.offchainState.setContractInstance(ledger);
await offchainState.compile();          // only when proofs are enabled
await OffchainLedger.compile();
const proof = await ledger.offchainState.createSettlementProof();
// then send a transaction calling ledger.settle(proof)
```

Traps:
- **A stale `from` is dropped silently** **[T]**. An `update({ from, to })` whose `from` no longer matches at settlement is skipped, not reverted, and the transaction that dispatched it still succeeds on chain. In the test, two transfers of 600 from a balance of 900 are both accepted; after settlement only the first took effect.
  - Never pay out, mint or emit something irreversible in the same method on the assumption that the update will apply.
  - Tell users that a transfer is final only after settlement.
- **Writes are invisible until settlement** **[T]**. `get()` returns the last settled value.
- **`overwrite()` has no `from` check.** Concurrent writers clobber each other.
- **Settle often.** If more actions are pending than one settlement can absorb, settlement has had bugs ([o1js#1887](https://github.com/o1-labs/o1js/issues/1887)).
