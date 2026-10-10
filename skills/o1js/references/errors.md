# Error messages

**[T]** marks messages reproduced by the tests in [../examples/](../examples/); the others come from the o1js 3.1 source or from issues.

## While compiling or analysing a contract

| Message | Cause | Fix |
|---|---|---|
| ``You used `this.x.get()` without adding a precondition that links it to the actual on-chain state.`` **[T]** | A method reads state with bare `get()` | `getAndRequireEquals()` ([security.md](security.md#3-state-read-without-a-precondition-t)) |
| ``x.toBoolean() was called on a variable field element `x` in provable code.`` (also `toBigInt`, `toString`, …) **[T]** | Converting a circuit variable to a JS value inside a method | `Provable.if`, `assert*`, or move the code outside the method ([provable-code.md](provable-code.md)) |
| `The Program you are trying to compile has no methods.` **[T]** | `compile()` on a contract without `@method`s | Add a method, or don't compile it |
| `Found 33 on-chain state field elements on X. Currently, only a total of 32 field elements of state are supported.` **[T]** | More than 32 field elements of `@state` (Structs count by their size) | Move data off-chain behind a Merkle root, or into `OffchainState` |
| `setBackend() must be called before initializeBindings().` | `setBackend('native')` called after o1js was initialised | Call it at the very top of the entry point, or set `O1JS_BACKEND=native` |
| TypeScript: `Unused '@ts-expect-error'` / method type errors around `@method` | Non-async method, or a ZkProgram method returning a bare value **[T]** | `@method async`, `return { publicOutput }` |

## While building or proving a transaction

| Message | Cause | Fix |
|---|---|---|
| ``X.deploy()` was called but no verification key was found. Try calling `await X.compile()` first`` **[T]** | Proofs are enabled but the contract wasn't compiled | `await X.compile()` before deploying |
| "The global context managed by o1js reached an inconsistent state" (often as an unhandled rejection), or a transaction that sends but changes nothing | A contract call inside `Mina.transaction` was not awaited. The method's account update was never added | `await zkApp.method()`; lint for floating promises (`@typescript-eslint/no-floating-promises`) |
| `Cannot push to an immutable forest` | Account updates added after the transaction's forest was finalised, e.g. from un-awaited async code | Await everything inside the transaction callback |
| `Field.assertEquals(): <a> != <b>` with no further explanation **[T]** | The same precondition set twice, e.g. two `requireBetween` calls. In 3.1 even identical ranges trigger it, and the explanatory "Precondition Error" text o1js prepares is not shown (o1js bug) | Set each precondition exactly once |
| `Number of account updates to approve exceed the supported limit of 9.` | A token transaction with more than `TokenContract.MAX_ACCOUNT_UPDATES` updates | Split the transaction |
| Errors thrown by your own `assert*` calls (custom message) | The method's logic rejected the input | Expected behaviour; check the inputs |

## When the transaction is applied (send / LocalBlockchain / node)

| Message | Cause | Fix |
|---|---|---|
| "…the transaction contains too many segments… The maximum number of segments per transaction is 16" **[T]** | Too many account updates (Mesa limit; the fee payer counts) | Fewer proof-authorized updates per transaction; split it |
| `Account_app_state_precondition_unsatisfied` | On-chain state changed between building and inclusion, usually another user's transaction in the same block, or a stale `fetchAccount` | Refetch and retry; for many concurrent users, use actions or per-user accounts ([actions-and-offchain-state.md](actions-and-offchain-state.md)) |
| `Account_nonce_precondition_unsatisfied` | Two transactions from the same fee payer with the same nonce: sent before the first was included, or a stale nonce | Wait for inclusion, or pass `nonce` explicitly in `Mina.transaction({ sender, fee, nonce }, …)` |
| `Update_not_permitted_access` **[T]** | An account update touched an account whose `access` permission it doesn't satisfy, e.g. bypassing a token contract | Expected for attacks; otherwise go through the contract's methods |
| `Update_not_permitted_*` (e.g. `_verification_key`, `_permissions`, `_zkapp_uri`) | The account's permissions forbid this change with this authorization | Check `Mina.getAccount(addr).permissions`; after Mesa, see [mesa.md](mesa.md) for the fallback |
| `Invalid_fee_excess`, which o1js rewrites as "Invalid fee excess. This means that balance changes in your transaction do not sum up…" | The transaction creates an account (also a token account) without paying the 1 MINA creation fee, or MINA balance changes don't balance | `AccountUpdate.fundNewAccount(feePayer, numberOfNewAccounts)` |
| Invalid signature on mainnet, while the same code works on devnet | `Mina.Network(url)` defaults to `networkId: 'devnet'` **[T: default]** | `Mina.Network({ networkId: 'mainnet', mina: url })` |
| Proof-authorized transactions to an old zkApp fail after 2026-09-03 | Its verification key was compiled before Mesa (o1js 2.x) | Recompile with o1js 3.1 and update the key with a signed transaction ([mesa.md](mesa.md)) |
| Reducer rollup can never succeed again | More pending actions than `maxUpdatesWithActions` / `maxActionsPerUpdate` allow **[T]** | See [actions-and-offchain-state.md](actions-and-offchain-state.md); a deployed contract may need a verification-key upgrade |

## In the browser

| Message | Cause | Fix |
|---|---|---|
| `SharedArrayBuffer is not defined` | The page isn't cross-origin isolated | Serve with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`; prove in a Web Worker |
| Second `prove()` hangs in a Web Worker | Fixed in o1js 3.0 ([o1js#2897](https://github.com/o1-labs/o1js/pull/2897)) | Upgrade to 3.1 |
| Out of memory / WASM memory errors on big circuits | Circuit too large for browser WASM | Smaller circuits, recursion, or proving server-side with the native backend |
