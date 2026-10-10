import { Field, Reducer, SmartContract, State, method, state } from 'o1js';

/**
 * Many users can increment in the same block: they only dispatch actions, which never conflict.
 * Anyone can later call `rollup()` to fold pending actions into the on-chain counter.
 *
 * Limits: reduce() handles at most `maxUpdatesWithActions` (default 32) account updates with pending actions,
 * and each may carry at most `maxActionsPerUpdate` (default 1) actions. Past that, rollup cannot be proven.
 */
export class ActionCounter extends SmartContract {
  reducer = Reducer({ actionType: Field });

  @state(Field) counter = State<Field>();
  @state(Field) actionState = State<Field>();

  init() {
    super.init();
    this.counter.set(Field(0));
    this.actionState.set(Reducer.initialActionState);
  }

  @method async increment() {
    this.reducer.dispatch(Field(1));
  }

  /** Dispatches two actions from one account update, so rollup() must allow maxActionsPerUpdate >= 2. */
  @method async incrementTwice() {
    this.reducer.dispatch(Field(1));
    this.reducer.dispatch(Field(1));
  }

  @method async rollup() {
    const counter = this.counter.getAndRequireEquals();
    const actionState = this.actionState.getAndRequireEquals();

    const pending = this.reducer.getActions({ fromActionState: actionState });
    // Keep the reducer callback pure: validate actions when they are dispatched, not here.
    const newCounter = this.reducer.reduce(pending, Field, (total, action) => total.add(action), counter, {
      maxUpdatesWithActions: 8,
      maxActionsPerUpdate: 2,
    });

    this.counter.set(newCounter);
    this.actionState.set(pending.hash);
  }
}
