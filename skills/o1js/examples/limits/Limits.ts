import { Field, Provable, SmartContract, State, method, state } from 'o1js';

/** A method with no state access, so many calls fit in one transaction. */
export class Noop extends SmartContract {
  @method async noop() {}
}

/** Mesa raised on-chain state from 8 to 32 field elements per account. */
export class FullState extends SmartContract {
  @state(Provable.Array(Field, 32)) data = State<Field[]>();

  // A contract needs at least one method to be compiled.
  @method async touch() {}
}

/** One field too many: deploying this must fail. */
export class TooMuchState extends SmartContract {
  @state(Provable.Array(Field, 33)) data = State<Field[]>();

  @method async touch() {}
}
