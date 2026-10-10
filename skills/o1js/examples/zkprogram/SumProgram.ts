import { Field, SelfProof, SmartContract, State, ZkProgram, method, state } from 'o1js';

/**
 * Recursive running sum, computed off-chain: each step proves `previous total + value`.
 * Public input: the total the chain started from. Public output: the total so far.
 */
export const SumProgram = ZkProgram({
  name: 'sum-program',
  publicInput: Field,
  publicOutput: Field,
  methods: {
    start: {
      privateInputs: [],
      async method(initial: Field) {
        return { publicOutput: initial };
      },
    },
    add: {
      privateInputs: [SelfProof, Field],
      async method(initial: Field, previous: SelfProof<Field, Field>, value: Field) {
        previous.verify();
        // Without this, a step could graft itself onto a chain that started from a different total.
        previous.publicInput.assertEquals(initial);
        return { publicOutput: previous.publicOutput.add(value) };
      },
    },
  },
});

export class SumProof extends ZkProgram.Proof(SumProgram) {}

/** Settles a whole off-chain chain of additions in one on-chain transaction. */
export class SumSettlement extends SmartContract {
  @state(Field) total = State<Field>();

  @method async settle(proof: SumProof) {
    proof.verify();
    // The chain must start from the current on-chain total, otherwise old work could be replayed.
    proof.publicInput.assertEquals(this.total.getAndRequireEquals());
    this.total.set(proof.publicOutput);
  }
}
