# Browser zkApps and wallets

Sources:
- the o1js 3 version of [tutorial 04](https://docs.minaprotocol.com/zkapps/tutorials/zkapp-ui-with-react) and its code in MinaProtocol/docs2 `examples/zkapps/04-zkapp-browser-ui`;
- the [Next.js guide](https://docs.minaprotocol.com/zkapps/front-end-integration-guides/next);
- the Auro provider types in [aurowallet/mina-provider](https://github.com/aurowallet/mina-provider).

*This page is not covered by this skill's tests; browsers aren't part of the test suite.*

## Architecture

- **Main thread:** UI and the wallet (`window.mina`).
- **Web Worker:** o1js. Compiling takes tens of seconds and proving several seconds, so both must run off the main thread.
- **Wallet's job:** add the fee payer, sign and send.

```
UI (React) ──Comlink──▶ Worker: Mina.Network, compile, fetchAccount, Mina.transaction, prove, tx.toJSON()
     │                                                    │
     └──── window.mina.sendTransaction({ transaction: json, feePayer: { fee, memo } }) ◀──┘
```

## Cross-origin isolation (required)

o1js's WASM prover uses `SharedArrayBuffer`, which browsers only allow on cross-origin-isolated pages. Without these headers you get `SharedArrayBuffer is not defined`.

```ts
// next.config.ts
const nextConfig = {
  async headers() {
    return [{
      source: '/(.*)',
      headers: [
        { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
      ],
    }];
  },
};
export default nextConfig;
```

```ts
// vite.config.ts
export default defineConfig({
  server: { headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } },
  preview: { headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } },
});
```

- Static hosts need the same two headers; on Vercel, put them in `vercel.json`.
- `require-corp` also applies to third-party resources: images, fonts and scripts from other origins need CORP/CORS headers or they stop loading.

## Worker with Comlink

```ts
// zkappWorker.ts — all o1js code lives here
import * as Comlink from 'comlink';
import { Mina, PublicKey, fetchAccount } from 'o1js';
import { Counter } from '../contracts/build/src/Counter.js';

let zkApp: Counter;
let tx: Awaited<ReturnType<typeof Mina.transaction>> | null = null;

export const api = {
  async setNetwork(graphqlUrl: string, networkId: 'mainnet' | 'devnet') {
    Mina.setActiveInstance(Mina.Network({ networkId, mina: graphqlUrl }));
  },
  async compile() {
    await Counter.compile();                          // once per page load; show progress in the UI
  },
  async init(zkAppAddress: string) {
    const publicKey = PublicKey.fromBase58(zkAppAddress);
    await fetchAccount({ publicKey });
    zkApp = new Counter(publicKey);
  },
  async buildIncrement(feePayer: string) {
    await fetchAccount({ publicKey: PublicKey.fromBase58(feePayer) });
    tx = await Mina.transaction(async () => {        // no sender: the wallet adds the fee payer
      await zkApp.increment();
    });
    await tx.prove();
    return tx.toJSON();                               // a string: safe to send to the main thread
  },
};
Comlink.expose(api);
```

```ts
// zkappWorkerClient.ts — runs in the main thread
import * as Comlink from 'comlink';

const worker = new Worker(new URL('./zkappWorker.ts', import.meta.url), { type: 'module' });
export const zkappWorker = Comlink.wrap<typeof import('./zkappWorker').api>(worker);
```

Rules:
- **Pass only plain data across the worker boundary:** base58 strings, JSON and numbers. Rebuild o1js values on each side, e.g. `Field.fromJSON(...)`. o1js objects do not survive `postMessage`.
- **Import o1js only in the worker,** or lazily. Importing it on the main thread loads the WASM there too.
- **Use one worker and keep it alive.** Compiling again in a new worker repeats the slow part.

## Wallet (Auro and compatible)

```ts
const mina = (window as any).mina;
if (!mina) throw new Error('No Mina wallet found');

const accounts = await mina.requestAccounts();       // asks the user to connect
if ('code' in accounts) throw new Error(accounts.message);   // errors are RETURNED, not thrown
const [address] = accounts;

const network = await mina.requestNetwork();          // { networkID, ... }: match the worker's Mina.Network to it

const json = await zkappWorker.buildIncrement(address);
const result = await mina.sendTransaction({
  transaction: json,
  feePayer: { fee: 0.1, memo: '' },                  // fee in MINA here; o1js itself counts in nanomina
});
if ('code' in result) throw new Error(result.message);
console.log(result.hash);

mina.on('accountsChanged', (accounts: string[]) => { /* reconnect / refetch */ });
mina.on('chainChanged', (chain: unknown) => { /* reconfigure the worker's network */ });
```

- **Plain payments and delegations** need no o1js: `sendPayment({ to, amount, fee?, memo? })` and `sendStakeDelegation({ to, fee?, memo? })`.
- **Other provider methods:** `signMessage`/`verifyMessage`, `signFields`/`verifyFields`, `signJsonMessage`, `createNullifier`, `storePrivateCredential` and `requestPresentation` (mina-attestations), `addChain`/`switchChain`, and the generic `request({ method, params })`.
- **Errors:** provider methods resolve to a `ProviderError` (`{ code, message }`) instead of rejecting. Check every result.
- **Mesa:** wallets must sign the Mesa transaction format. Auro's browser extension 2.5.4 (2026-09-20) depends on o1js 3.0.0 and mina-signer 4.1.0, per its [package.json](https://github.com/aurowallet/auro-wallet-browser-extension/blob/master/package.json). Check other wallets before relying on them.
- **The wallet-agnostic Provider API** (`mina_*` JSON-RPC methods, EIP-6963-style discovery) is still a draft MIP and not merged; code against Auro's provider today.

## UX checklist

- **Prepare early:** compile on page load, in the worker, before the user clicks anything. Show "preparing (first time ~30–60 s)".
- **Check the fee payer before proving.** `fetchAccount` on the fee payer tells you whether it exists and is funded; a new account can't pay.
- **Show the full flow:** prove (seconds), wallet approval, then inclusion. Mesa slots are 90 s, so a transaction typically lands within a few minutes; poll or link to an explorer.
- **Stale reads:** state read for the UI can be stale by the time the transaction lands. Expect `Account_app_state_precondition_unsatisfied` under concurrency and offer a retry ([errors.md](errors.md)).
