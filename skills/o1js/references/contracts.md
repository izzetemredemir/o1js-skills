# Smart contracts

A zkApp is a `SmartContract` subclass.
- **Each `@method` compiles to a circuit.** Calling one inside `Mina.transaction` creates an account update for the contract, authorized by a proof of that circuit.
- **On chain, only the proof is verified.** The method body runs on the user's machine.

Working examples: [counter](../examples/counter/Counter.ts), [token](../examples/token/SimpleToken.ts), [reducer](../examples/reducer/ActionCounter.ts), [zkprogram](../examples/zkprogram/SumProgram.ts).

## Skeleton

```ts
import { Field, PublicKey, SmartContract, State, Struct, method, state } from 'o1js';

class Config extends Struct({ admin: PublicKey, limit: Field }) {}

export class MyApp extends SmartContract {
  @state(Field) total = State<Field>();
  @state(Config) config = State<Config>();   // a Struct uses as many fields as it serializes to

  events = { added: Field };                 // declare event types up front

  init() {                                   // runs inside deploy() when the account has no verification key yet
    super.init();
    this.total.set(Field(0));
  }

  @method async add(x: Field) {
    const total = this.total.getAndRequireEquals();
    x.assertLessThan(Field(1000));
    this.total.set(total.add(x));
    this.emitEvent('added', x);
  }

  @method.returns(Field) async peek(): Promise<Field> {
    return this.total.getAndRequireEquals();
  }
}
```

### Rules
- **`@method` functions must be `async`,** and callers must `await` them. Without the `await`, a method that awaits anything internally adds **no** account update. The transaction still builds and sends (fee only), and a later unhandled rejection reports "The global context managed by o1js reached an inconsistent state". Check `tx.transaction.accountUpdates.length` in tests, and lint for floating promises.
- **Arguments must be provable types:** `Field`, `Bool`, `UInt64`, `PublicKey`, `Struct`, `Proof` classes, and so on. Their types come from decorator metadata, which is why the tsconfig needs `emitDecoratorMetadata` and builds must use `tsc`.
- **At most 30 methods per contract.** Every compiled method is callable by anyone; there are no private or internal methods.
- **On-chain state is limited to 32 field elements per account** (Mesa). A `Struct` uses as many as it serializes to. Store large data off-chain behind a Merkle root.
- **State initial values:**
  - `@state(Field) x = State(Field(5))` sets an initial value that the default `init()` applies.
  - An overridden `init()` must call `super.init()`.

## State

| API | Use |
|---|---|
| `getAndRequireEquals()` | Read the value and require on-chain state to equal it. The normal way to read |
| `get()` + `requireEquals(v)` | The same, in two steps |
| `requireEqualsIf(cond, v)` | Conditional precondition |
| `set(v)` | Write at the end of the account update. A `get()` after `set()` returns the old value **[T]** |
| `fetch()` | Outside circuits: read the current value from the network |
| `requireNothing()` | Explicitly no precondition. Almost always a bug in contract logic ([security.md](security.md#3-state-read-without-a-precondition-t)) |

A contract whose method calls `get()` without a precondition fails to compile in o1js 3 **[T]**.

## Preconditions on the account and the network

```ts
this.account.balance.requireBetween(UInt64.from(1e9), UInt64.MAXINT());
this.account.nonce.requireEquals(nonce);
this.account.isNew.requireEquals(Bool(true));          // creation must happen exactly once
this.account.provedState.requireEquals(Bool(false));   // only before all state was set by proofs
this.currentSlot.requireBetween(start, end);           // slot of inclusion: use this for deadlines
this.network.blockchainLength.requireBetween(a, b);
```

- Set each precondition once per account update, in one place ([security.md](security.md#16-precondition-and-state-semantics-t)).
- Prefer `this.currentSlot` for deadlines. `this.network.globalSlotSinceGenesis` refers to the previous block.
- Mesa slots are 90 s (90 000 ms). `Mina.getNetworkConstants().slotTime` (in ms) reflects the real network only after o1js has fetched its genesis constants; on a fresh `Mina.Network` it still returns the old 180 000 ms default. Derive durations from the network you target, not from a hard-coded 3-minute slot.

## Who is calling

```ts
const caller = this.sender.getAndRequireSignature(); // the transaction must be signed by this key
caller.assertEquals(this.config.getAndRequireEquals().admin);
```

`this.sender.getUnconstrained()` is chosen by the prover, so it is fine for logging or UX, never for authorization. The sender is not necessarily the fee payer, and there is no `msg.sender` for contract-to-contract calls.

## Moving MINA

```ts
// contract pays out (needs the `send` permission, `proof` by default)
this.send({ to: recipient, amount: UInt64.from(1_000_000_000) });

// user pays the contract, inside the same transaction
const payment = AccountUpdate.createSigned(user);
payment.send({ to: this.address, amount });
```

Sending to an account that does not exist yet costs the account creation fee (1 MINA). Add `AccountUpdate.fundNewAccount(feePayer)` to the transaction.

## Events

```ts
events = { added: Field, transfer: TransferEvent };   // TransferEvent is a Struct
this.emitEvent('added', x);
this.emitEventIf(isLarge, 'added', x);
const events = await zkApp.fetchEvents();             // [{ type, event: { data, ... }, blockHeight, ... }]
```

Tested in [Counter.test.ts](../examples/counter/Counter.test.ts).

- **Size limit:** since Mesa, a transaction can carry up to 1024 field elements of events and, separately, 1024 of actions. There is no longer a per-event cap.
- **Events are public;** never emit secrets.
- **On a live network, `fetchEvents` reads the archive node.** Check that the archive is synced ([mesa.md](mesa.md#network-configuration)).

## Calling another contract

```ts
@method async useOracle(oracleAddress: PublicKey) {
  const oracle = new Oracle(oracleAddress);
  const price = await oracle.price();   // a @method.returns(UInt64) on the other contract
  price.assertGreaterThan(UInt64.from(100));
}
```

- The callee's proof is generated and verified as part of the transaction.
- Since 3.1, nested calls are bound to the token ID passed to the callee's constructor.
- Only call contracts whose verification key and permissions are locked; otherwise their behaviour can change under you.

## Deploying

- **`deploy()`:**
  - It is signature-authorized: sign it with the zkApp key, plus the fee payer.
  - It sets the verification key, runs `init()` on a new account, and resets permissions to `Permissions.default()`. Set custom permissions **after** `super.deploy()` in an overridden `deploy()`, or in `init()`.
  - **Never call `deploy()` on an existing contract to upgrade it** **[T]**. See [mesa.md](mesa.md#upgrading-a-contract-deployed-before-mesa).
- **Initial state that must be proven:** use a separate `@method` guarded by `this.account.provedState.requireEquals(Bool(false))`, and send it in the same transaction as `deploy()`.
- **Permissions:** default to locking down everything you don't need. The recommended set and the reasoning are in [security.md](security.md#7-weak-or-accidental-permissions-t).
