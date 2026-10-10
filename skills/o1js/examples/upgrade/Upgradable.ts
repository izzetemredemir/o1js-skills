import { Field, SmartContract, State, method, state } from 'o1js';

/** Version 1 of a contract whose code is later replaced. State layout must stay compatible across versions. */
export class CounterV1 extends SmartContract {
  @state(Field) count = State<Field>();

  @method async bump() {
    this.count.set(this.count.getAndRequireEquals().add(1));
  }
}

/** Version 2: same state layout, new behaviour. */
export class CounterV2 extends SmartContract {
  @state(Field) count = State<Field>();

  @method async bump() {
    this.count.set(this.count.getAndRequireEquals().add(10));
  }
}
