# Writing provable code

Code inside a `@method`, a ZkProgram method or `Provable.runAndCheck` is traced into a circuit.
- **Provable values** (`Field`, `Bool`, `UInt64`, …) become variables and constraints.
- **Plain JavaScript runs once while the circuit is built** and decides its *shape*, not its *values*.

Most bugs come from mixing the two up ([security.md](security.md)).

## Types

| Type | Use | Notes |
|---|---|---|
| `Field` | Native element mod p (about 2^254) | Wraps around: `Field(0).sub(1)` is `p - 1`. `div` is modular inversion **[T]** |
| `Bool` | Booleans | A JS object: never use it in `if`/`while`/`?:` **[T]** |
| `UInt64`, `UInt32`, `UInt8` | Amounts, counters | Range-checked; throw on overflow and underflow **[T]**. `div`/`mod` are integer division |
| `Int64` | Signed amounts (balance changes) | `Int64.from(n)`, `Int64.create(magnitude, sign)` |
| `PublicKey`, `PrivateKey`, `Signature` | Keys and Schnorr signatures | `Signature.verify` is network-agnostic ([security.md](security.md#9-signature-replay-and-missing-domain-separation)) |
| `Struct({...})` | Composite types | Replaces `CircuitValue`. Don't override `fromFields` |
| `Provable.Array(T, n)` | Fixed-length arrays | Length is part of the circuit |
| `Bytes(n)`, `CircuitString` | Byte strings | `class Bytes32 extends Bytes(32) {}` |
| `MerkleTree` / `MerkleWitness(h)`, `MerkleMap`, `IndexedMerkleMap` | Off-chain storage behind a root | `IndexedMerkleMap` is top-level since 2.7 **[T]**; keep tree heights ≤ 255 |
| `createForeignField`, `createForeignCurve`, `createEcdsa` | Non-native fields, secp256k1/r1, ECDSA | Expensive; consider the native prover with chunking |

Converting to JS values: `UInt64`/`UInt8` use `toBigInt()`, `UInt32`/`Int64` use `toBigint()` **[T]**, `Bool` uses `toBoolean()`. **All of these throw inside provable code.** Use them only on results outside the method.

## Conditionals

```ts
// select a value
const fee = Provable.if(isMember, UInt64.from(10), UInt64.from(50));
const point = Provable.if(flag, Point, a, b);          // structs need the type argument

// conditional assertion: "if isMint then amount <= cap"
isMint.not().or(amount.lessThanOrEqual(cap)).assertTrue();

// conditional state precondition / event
this.counter.requireEqualsIf(shouldCheck, expected);
this.emitEventIf(isLarge, 'large', amount);
```

**Both branches of `Provable.if` are always computed and constrained** **[T]**. A division by zero or a `UInt64` underflow in the unused branch still fails. Make both branches safe:

```ts
const safeDivisor = Provable.if(d.equals(0), Field(1), d);
const q = Provable.if(d.equals(0), Field(0), n.div(safeDivisor));
```

Use `Provable.equal(Type, a, b)` to compare structs; the 2-argument form was removed in 2.0 **[T]**.

## Assertions

`equals`, `lessThan`, `greaterThanOrEqual` and similar return a `Bool` and constrain **nothing** until asserted **[T]**. Use the `assert*` forms:

```ts
x.assertEquals(y);
amount.assertLessThanOrEqual(balance, 'insufficient balance');   // optional message
flag.assertTrue();
Provable.assertEqual(Point, a, b);
```

Most `assert*` methods take an optional error message as their last argument. The exception is `assertEquals` on `UInt64` and `UInt32`: it takes no message, and passing one is a compile error **[T]**. `Field`, `Bool`, `Int64` and `UInt8` accept one. For a message on a `UInt64` equality, use `a.equals(b).assertTrue('message')`.

## Loops

Loop bounds must be JS constants. Iterate to a maximum and mask with a `Bool`:

```ts
const MAX = 16;
let sum = UInt64.zero;
for (let i = 0; i < MAX; i++) {
  const active = UInt32.from(i).lessThan(length);
  sum = Provable.if(active, sum.add(items[i]), sum);
}
```

`for (let i = 0; i < Number(n.toBigInt()); i++)` throws inside a method, and "fixing" it with `asProver` produces a loop with no constraints.

## Witnesses

`Provable.witness` brings a value computed outside the circuit into it. The callback is a **hint**: it runs only on the prover's machine, and the value is unconstrained until you assert something about it.

```ts
// division with remainder: witness, then prove it is correct
const q = Provable.witness(UInt64, () => a.toBigInt() / b.toBigInt());
const r = Provable.witness(UInt64, () => a.toBigInt() % b.toBigInt());
q.mul(b).add(r).assertEquals(a);
r.assertLessThan(b);

// square root: also pin the root you mean (parity/sign)
const root = Provable.witness(Field, () => x.sqrt());
root.mul(root).assertEquals(x);
```

- `Provable.witness(UInt64, …)` range-checks the result. `UInt64.Unsafe.fromField` does not.
- The callback may return plain JS values (`bigint`, `number`, `boolean`).
- Async callbacks: use `Provable.witnessAsync`.
- `Provable.asProver(() => …)` runs code only while proving, e.g. for logging. It must never contain checks.
- Don't use randomness (`Math.random()`, `Field.random()`, `Date.now()`) inside a witness. The method runs more than once and the values must agree. Pass randomness in as an argument.

## Hashing

| Function | Use |
|---|---|
| `Poseidon.hash(fields)` | Fixed-length input. Zero-pads, so `[x]` collides with `[x, 0]` **[T]** |
| `Poseidon.hashAnyLength(fields)` | Variable-length input; appends the length (o1js ≥ 2.14, different output from `hash`) **[T]** |
| `Poseidon.hashWithPrefix(prefix, fields)` | Domain separation: one prefix per purpose |
| `Hash.SHA2_256.hash(bytes)`, `Hash.Keccak256`, `Hash.SHA3_*`, `Hash.BLAKE2B` | Interop with other chains; much more expensive than Poseidon |

`Gadgets.SHA256` is deprecated; use `Hash.SHA2_256`.

## Measuring circuit size

```ts
const methods = await MyContract.analyzeMethods();   // async since 0.18
console.log(methods.myMethod.rows);
const cs = await Provable.constraintSystem(() => { ... });
```

`analyzeMethods()` is also the fastest way to catch circuit-only errors without proving, such as `toBoolean()` on a variable or a bare `get()` **[T]**.
