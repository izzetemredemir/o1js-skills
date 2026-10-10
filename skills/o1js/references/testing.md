# Project setup and testing

## Setup

```bash
npm init -y
npm install o1js@^3.1.0
npm install -D typescript @types/node
```

- **`package.json`:** add `"type": "module"` and `"engines": { "node": ">=22.19.5" }`.
- **zkapp-cli:** `zk project <name>` works, but change its `"o1js": "^2.*"` to `^3.1.0` before writing code (zkapp-cli 0.23.0).

`tsconfig.json`: these options are required. The rest is the zkapp-cli template, also used by [../examples/tsconfig.json](../examples/tsconfig.json):

```json
{
  "compilerOptions": {
    "target": "es2021",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "strictPropertyInitialization": false,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "useDefineForClassFields": false,
    "skipLibCheck": true
  }
}
```

Why these matter:
- **`emitDecoratorMetadata`** is how `@method` learns its argument types. esbuild-based tools (tsx, Vite, Vitest's default transform) don't emit decorator metadata, so build contracts with `tsc`.
- **`useDefineForClassFields: false`** keeps `@state` and `reducer` class fields working.
- **Imports:** with `nodenext`, relative imports need the `.js` extension (`import { Counter } from './Counter.js'`).

## Test structure

The examples in this skill use `node:test` on the compiled output, like the zkapp-cli template:

```json
"scripts": {
  "build": "tsc",
  "test": "npm run build && node --test 'build/**/*.test.js'",
  "test:proofs": "npm run build && PROOFS=1 node --test 'build/**/*.test.js'"
}
```

```ts
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { AccountUpdate, Field, Mina, PrivateKey } from 'o1js';
import { Counter } from './Counter.js';

const proofsEnabled = process.env.PROOFS === '1';

describe('Counter', () => {
  let sender: Mina.TestPublicKey;
  const zkAppKey = PrivateKey.random();
  const zkApp = new Counter(zkAppKey.toPublicKey());

  before(async () => {
    if (proofsEnabled) await Counter.compile();      // compile only when proving
    const local = await Mina.LocalBlockchain({ proofsEnabled });
    Mina.setActiveInstance(local);
    [sender] = local.testAccounts;

    const tx = await Mina.transaction(sender, async () => {
      AccountUpdate.fundNewAccount(sender);
      await zkApp.deploy();
    });
    await tx.prove();
    await tx.sign([sender.key, zkAppKey]).send();
  });

  it('increments', async () => {
    const tx = await Mina.transaction(sender, async () => { await zkApp.increment(); });
    await tx.prove();
    await tx.sign([sender.key]).send();
    assert.deepEqual(zkApp.count.get(), Field(1));
  });
});
```

### Practices
- **Two modes:**
  - `proofsEnabled: false` checks all assertions and permissions, and is fast: the 62 tests here take about 15 s.
  - With proofs, the same suite takes about 9 minutes. Run it before deploying and in CI. Some problems only appear when compiling, for example a contract with no methods.
- **Test the attacks,** not just the happy path:
  - transactions that must fail (`await assert.rejects(...)`, matching the error text);
  - bypass attempts that build account updates by hand ([SimpleToken.test.ts](../examples/token/SimpleToken.test.ts));
  - wrong signers;
  - stale proofs.
- **Catch circuit-only errors without proving:** `await MyContract.analyzeMethods()`.
- **Pin the facts you rely on.** [api-surface.test.ts](../examples/api-surface/api-surface.test.ts) and [type-checks.ts](../examples/api-surface/type-checks.ts) fail as soon as an o1js upgrade changes them.
- **One `LocalBlockchain` per suite.** Contracts compiled once can be reused across suites.

## Beyond LocalBlockchain

- **Lightnet:** a single-node Mina network in Docker, managed by zkapp-cli.
  - Start it with `zk lightnet start -b mesa`. The default image (`compatible`) is not the Mesa protocol; the `mesa` branch exists since zkapp-cli 0.23.0.
  - It provides GraphQL at `http://127.0.0.1:8080/graphql`, the archive at `http://127.0.0.1:8282` and the account manager at `http://127.0.0.1:8181`.
  - Use it to test `fetchEvents`, `Mina.fetchActions`, real fees and real block inclusion ([transactions.md](transactions.md#networks)).
- **Devnet:** the public test network (`networkId: 'devnet'`), funded through `Mina.faucet(publicKey)`. Test the exact deployment and upgrade scripts here before mainnet.
