// Each contract here compiles and runs, and each one is wrong. Pitfalls.test.ts shows how.
import { Bool, Field, Provable, Reducer, SmartContract, State, method, state } from 'o1js';

export class Pitfalls extends SmartContract {
  @state(Field) x = State<Field>();

  /** WRONG: a Bool is a JS object, so `if (flag)` is always true and the circuit ignores the flag. */
  @method async jsIf(flag: Bool, value: Field) {
    this.x.getAndRequireEquals();
    if (flag) this.x.set(value);
  }

  /** RIGHT: select in-circuit. */
  @method async provableIf(flag: Bool, value: Field) {
    const current = this.x.getAndRequireEquals();
    this.x.set(Provable.if(flag, value, current));
  }

  /** WRONG: equals() returns a Bool and constrains nothing unless it is asserted. */
  @method async unassertedEquals(guess: Field) {
    this.x.getAndRequireEquals().equals(guess);
  }

  /** RIGHT */
  @method async assertedEquals(guess: Field) {
    this.x.getAndRequireEquals().assertEquals(guess);
  }

  /** WRONG: get() after set() in the same method still returns the old value. */
  @method.returns(Field) async readAfterWrite() {
    const current = this.x.getAndRequireEquals();
    this.x.set(current.add(1));
    return this.x.get();
  }
}

/** WRONG: get() without a precondition. o1js 3 refuses to compile or analyse this contract at all. */
export class BareGet extends SmartContract {
  @state(Field) x = State<Field>();

  @method async read() {
    this.x.get();
  }
}

/** WRONG: toBoolean() needs a concrete value, which does not exist while the circuit is being compiled. */
export class ToBooleanInCircuit extends SmartContract {
  @method async run(flag: Bool) {
    if (flag.toBoolean()) Field(1).assertEquals(1);
  }
}

/** WRONG: a method dispatches two actions, but reduce() keeps the default maxActionsPerUpdate of 1. */
export class DoubleDispatch extends SmartContract {
  reducer = Reducer({ actionType: Field });
  @state(Field) counter = State<Field>();
  @state(Field) actionState = State<Field>();

  init() {
    super.init();
    this.actionState.set(Reducer.initialActionState);
  }

  @method async incrementTwice() {
    this.reducer.dispatch(Field(1));
    this.reducer.dispatch(Field(1));
  }

  @method async rollup() {
    const counter = this.counter.getAndRequireEquals();
    const pending = this.reducer.getActions({ fromActionState: this.actionState.getAndRequireEquals() });
    this.counter.set(this.reducer.reduce(pending, Field, (total, action) => total.add(action), counter));
    this.actionState.set(pending.hash);
  }
}
