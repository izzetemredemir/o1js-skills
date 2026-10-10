import { Field, SmartContract, State, method, state } from 'o1js';

export class MyContract extends SmartContract {
  @state(Field) value = State<Field>();

  @method async bump() {
    const current = this.value.getAndRequireEquals();
    this.value.set(current.add(1));
  }
}
