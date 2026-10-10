# Transactions and networks

## Flow

```ts
const tx = await Mina.transaction({ sender, fee: 100_000_000, memo: 'hello' }, async () => {
  AccountUpdate.fundNewAccount(sender);   // once per account this transaction creates
  await zkApp.someMethod(arg);
});
await tx.prove();                         // proves every @method call in the transaction
const pending = await tx.sign([senderKey, ...otherKeys]).send();
const included = await pending.wait();    // throws if the transaction is rejected
```

What each step does:
- **`Mina.transaction`** runs the callback to build the account updates.
  - The callback must be `async` **[T]**.
  - The first argument is a `PublicKey` or `{ sender, fee?, memo?, nonce? }`. A private key is not accepted.
- **`prove()`** resolves to the transaction itself, so chaining works:
  `await Mina.transaction(...).prove().sign([...]).send().wait()`.
- **`sign()`** adds signatures for the fee payer and for every account update that needs one: `requireSignature()`, `AccountUpdate.createSigned`, `deploy()`, or `this.sender.getAndRequireSignature()`.
- **The result:**
  - `pending.hash` is a property.
  - `send()` rejects if the node refuses the transaction.
  - `safeSend()` / `safeWait()` return a status instead of throwing.

## Fees and limits

- **Fees:** `fee` is in nanomina (1 MINA = 1e9). Both `tx.setFee(UInt64)` and `tx.setFeePerAccountUpdate(n)` exist. `setFeePerSnarkCost` and `TransactionCost.*` were removed.
- **Mesa size limit: 16 segments per transaction.**
  - Proof-authorized updates count 1 each.
  - Consecutive non-proof updates pair up.
  - The fee payer counts as one.
  - The fee payer plus 15 proof-authorized updates fits; one more fails with an error containing "The maximum number of segments per transaction is 16" **[T: [Limits.test.ts](../examples/limits/Limits.test.ts)]**.
  - `Mina.Network({ bypassTransactionLimits: true })` and `LocalBlockchain({ enforceTransactionLimits: false })` exist for experiments only; the network still enforces the limit.
- **Account creation fee:** creating any account, including a token account, costs 1 MINA (`Mina.getNetworkConstants().accountCreationFee`). Add `AccountUpdate.fundNewAccount(feePayer, count)`. If you forget, the transaction fails with `Invalid_fee_excess` (o1js shows it as "Invalid fee excess…").

## Account updates by hand

```ts
const signed = AccountUpdate.createSigned(address);   // requires that key's signature
signed.send({ to: recipient, amount });
signed.account.verificationKey.set(newVk);             // e.g. a verification-key upgrade

const unsigned = AccountUpdate.create(address);       // no authorization: only changes allowed with `none`

const maybe = AccountUpdate.createIf(condition, address); // 3.1: OptionalAccountUpdate
maybe.value;                                               // the AccountUpdate inside **[T]**
```

`AccountUpdate.default(address, tokenId)` creates an update that is not attached to the transaction yet. Token contracts use it to build updates they then approve.

## Networks

```ts
// local, in-process (tests)
const local = await Mina.LocalBlockchain({ proofsEnabled: false });
Mina.setActiveInstance(local);
const [alice, bob] = local.testAccounts;          // TestPublicKey: alice.key is the PrivateKey

// live network
Mina.setActiveInstance(Mina.Network({
  networkId: 'mainnet',                           // or 'devnet'; the default is 'devnet' [T]
  mina: GRAPHQL_URL,                              // node GraphQL; an array enables failover
  archive: ARCHIVE_URL,                           // needed for fetchEvents / fetchActions
}));
await fetchAccount({ publicKey: zkAppAddress });  // load accounts before building transactions
await fetchAccount({ publicKey: sender });

// lightnet (local Docker network started with `zk lightnet start -b mesa`)
Mina.setActiveInstance(Mina.Network({
  mina: 'http://127.0.0.1:8080/graphql',
  archive: 'http://127.0.0.1:8282',
  lightnetAccountManager: 'http://127.0.0.1:8181',
}));
const { publicKey, privateKey } = await Lightnet.acquireKeyPair();
```

Notes:
- **Fetching:**
  - `fetchEvents` is a top-level export; actions are fetched with `Mina.fetchActions` **[T]**. Both accept `from`/`to` height filters (since 2.3).
  - `fetchCurrentSlot()` returns the current global slot.
- **Devnet funds:** `Mina.faucet(publicKey)` requests devnet funds.
- **Lightnet:** zkapp-cli 0.23.0 and o1js 3 support Mesa lightnet. Check the zkapp-cli docs for the current ports before hard-coding them.
- **Archive endpoints can lag behind the chain.** After Mesa at least one public mainnet archive stopped indexing at the fork block. Compare its latest block with the node before trusting events or actions.

## Signing outside o1js

`mina-signer` (v4) signs payments, delegations and zkApp commands. It signs the Mesa format by default; use `era: 'berkeley'` only for the old format.

```ts
import Client from 'mina-signer';
const client = new Client({ network: 'mainnet' });
```

`getZkappCommandCommitments` (3.0) lets external signers (hardware wallets, multisig) sign zkApp commands. In a browser zkApp, let the wallet sign:

```ts
// Auro and compatible wallets; optional: feePayer: { fee, memo }, nonce, onlySign
await window.mina.sendTransaction({ transaction: tx.toJSON() });
```

The wallet-agnostic Provider API (`mina_*` JSON-RPC methods) is still a draft MIP and not merged. The full browser flow (worker, headers, wallet errors) is in [frontend.md](frontend.md).
