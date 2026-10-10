import { Experimental, Field, Provable, SmartContract, State, UInt64, method, state } from 'o1js';

const { BatchReducer } = Experimental;

/** Processes any number of pending actions in fixed-size batches, one transaction per batch. */
export const batchReducer = new BatchReducer({
  actionType: UInt64,
  batchSize: 3,
  maxUpdatesPerProof: 4,
  maxUpdatesFinalProof: 4,
});
export class Batch extends batchReducer.Batch {}
export class BatchProof extends batchReducer.BatchProof {}

export class BatchTotal extends SmartContract {
  // BatchReducer requires exactly these two state fields.
  @state(Field) actionState = State(BatchReducer.initialActionState);
  @state(Field) actionStack = State(BatchReducer.initialActionStack);

  @state(UInt64) total = State(UInt64.zero);

  @method async deposit(amount: UInt64) {
    // Validate at dispatch time: the batch callback also sees dummy entries.
    amount.assertGreaterThan(UInt64.zero);
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
