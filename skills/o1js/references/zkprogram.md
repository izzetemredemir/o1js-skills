# ZkProgram, recursion and proving

A `ZkProgram` is a set of provable functions that produce proofs off-chain. Proofs can verify other proofs (recursion) and can be verified inside contract methods. That is how large computations are compressed into one on-chain transaction.

Tested example: [SumProgram.ts](../examples/zkprogram/SumProgram.ts), [SumProgram.test.ts](../examples/zkprogram/SumProgram.test.ts).

## Defining a program

```ts
import { Field, SelfProof, ZkProgram } from 'o1js';

export const SumProgram = ZkProgram({
  name: 'sum-program',
  publicInput: Field,     // optional
  publicOutput: Field,    // optional
  methods: {
    start: {
      privateInputs: [],
      async method(initial: Field) {
        return { publicOutput: initial };          // not `return initial`  [T]
      },
    },
    add: {
      privateInputs: [SelfProof, Field],
      async method(initial: Field, previous: SelfProof<Field, Field>, value: Field) {
        previous.verify();
        previous.publicInput.assertEquals(initial); // pin the chain to its starting point
        return { publicOutput: previous.publicOutput.add(value) };
      },
    },
  },
});

export class SumProof extends ZkProgram.Proof(SumProgram) {}  // or SumProgram.Proof
```

- **Method signature:** the public input comes first, then the `privateInputs` in order.
- **Return value:** methods return `{ publicOutput }` and optionally `auxiliaryOutput`, a value returned to the caller but not part of the proof.
- **Recursion:** `SelfProof<In, Out>` verifies proofs of the same program. Verify proofs of another program with that program's `Proof` class in `privateInputs`. Proofs can also sit inside a `Struct`, except `SelfProof`.

## Proving and verifying

```ts
await SumProgram.compile();                                   // slow; cache it (below)
const { proof: p0 } = await SumProgram.start(Field(0));       // resolves to { proof, auxiliaryOutput }  [T]
const { proof: p1 } = await SumProgram.add(Field(0), p0, Field(5));
const ok = await SumProgram.verify(p1);                       // Promise<boolean>; await it  [T]

const json = p1.toJSON();
const restored = await SumProof.fromJSON(json);               // async since 1.0
```

Provers accept plain JS values (`5n`, `true`) since 2.3.

## Settling a proof in a contract

```ts
export class SumSettlement extends SmartContract {
  @state(Field) total = State<Field>();

  @method async settle(proof: SumProof) {
    proof.verify();                                                  // without this, nothing is checked
    proof.publicInput.assertEquals(this.total.getAndRequireEquals()); // tie the proof to current state
    this.total.set(proof.publicOutput);
  }
}
```

- **Compile order:** compile the program before the contract that verifies its proofs.
- **Why pin the public input:** `settle` rejects a proof whose chain does not start from the on-chain total. Without that check, an old proof could be replayed **[T]**.

## Proofs disabled in tests

```ts
await SumProgram.compile({ proofsEnabled: false }); // or SumProgram.setProofsEnabled(false)
```

With proofs disabled, methods run and their assertions are checked, but no real proof is created. That is fast enough for unit tests. Always also run with proofs before deploying: some problems, such as a contract with no methods, only appear when compiling.

## Dynamic proofs (side-loaded verification keys)

When the verifying circuit must accept proofs from programs that are not known at compile time:

```ts
class AnyProof extends DynamicProof<Field, Field> {
  static publicInputType = Field;
  static publicOutputType = Field;
  static maxProofsVerified = 0 as const;
  static featureFlags = FeatureFlags.allMaybe;
}
// inside a method: proof.verify(verificationKey) — and constrain verificationKey.hash to an allowed value!
```

`FeatureFlags.fromZkProgram(P)` is async. An unconstrained verification key means "any program": always check its hash against state or a constant.

## Compile caching and performance

```ts
import { Cache, setBackend } from 'o1js';

setBackend('native');                                             // Node only; before anything initialises o1js
await SumProgram.compile({ cache: Cache.FileSystem('./cache') }); // reuses keys across runs
```

- **Native prover (3.0+):** about 2× faster proving. Available on linux-x64/arm64 and darwin-x64/arm64, not Windows or browsers. `O1JS_BACKEND=native` does the same as `setBackend('native')`.
- **Chunking (`numChunks`):** splits large circuits, about 4× larger on Node.
- **Caches:** regenerate them after upgrading o1js; 3.0 changed every key.
- **Browsers:** compile and prove in a Web Worker. `SharedArrayBuffer` requires COOP/COEP headers (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`).
- **Circuit size:** use `await P.analyzeMethods()` and keep loops bounded by constants.
- **Inspecting a program:** `await P.maxProofsVerified()`, `Experimental.Recursive(P)` for recursion helpers, `analyzeSingleMethod` (2.7) for one method.
