import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { AccountUpdate, Mina, PrivateKey, UInt64 } from 'o1js';
import { proofsEnabled } from '../shared/test-utils.js';
import { BatchTotal, batchReducer } from './BatchTotal.js';

describe('BatchTotal (Experimental.BatchReducer)', () => {
  let users: Mina.TestPublicKey[];
  const key = PrivateKey.random();
  const zkApp = new BatchTotal(key.toPublicKey());

  async function send(sender: Mina.TestPublicKey, body: () => Promise<void>) {
    const tx = await Mina.transaction(sender, body);
    await tx.prove();
    await tx.sign([sender.key]).send();
  }

  before(async () => {
    batchReducer.setContractClass(BatchTotal);
    if (proofsEnabled) {
      await batchReducer.compile();
      await BatchTotal.compile();
    }
    const local = await Mina.LocalBlockchain({ proofsEnabled });
    Mina.setActiveInstance(local);
    users = local.testAccounts.slice(0, 4);
    batchReducer.setContractInstance(zkApp);

    const tx = await Mina.transaction(users[0], async () => {
      AccountUpdate.fundNewAccount(users[0]);
      await zkApp.deploy();
    });
    await tx.prove();
    await tx.sign([users[0].key, key]).send();
  });

  it('rejects invalid actions at dispatch time', async () => {
    await assert.rejects(send(users[0], () => zkApp.deposit(UInt64.zero)));
  });

  it('processes more actions than one batch holds, one transaction per batch', async () => {
    const amounts = [5, 10, 20, 1, 2, 3, 4];
    for (const [i, amount] of amounts.entries()) {
      await send(users[i % users.length], () => zkApp.deposit(UInt64.from(amount)));
    }

    const batches = await batchReducer.prepareBatches();
    assert.equal(batches.length, 3, '7 actions in batches of 3');
    for (const { batch, proof } of batches) {
      await send(users[0], () => zkApp.process(batch, proof));
    }
    assert.deepEqual(zkApp.total.get(), UInt64.from(45));
  });
});
