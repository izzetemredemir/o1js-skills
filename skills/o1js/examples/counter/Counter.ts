import { Field, SmartContract, State, method, state } from 'o1js';

/** Smallest useful zkApp: one on-chain field that only goes up by one per call, and an event per change. */
export class Counter extends SmartContract {
  @state(Field) count = State<Field>();

  events = { incremented: Field };

  init() {
    super.init();
    this.count.set(Field(0));
  }

  @method async increment() {
    const current = this.count.getAndRequireEquals();
    const next = current.add(1);
    this.count.set(next);
    this.emitEvent('incremented', next);
  }
}
