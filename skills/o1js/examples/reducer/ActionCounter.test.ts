import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { AccountUpdate, Field, Mina, PrivateKey } from 'o1js';
import { proofsEnabled } from '../shared/test-utils.js';
import { ActionCounter } from './ActionCounter.js';

describe('ActionCounter', () => {
  let users: Mina.TestPublicKey[];
  const zkAppKey = PrivateKey.random();
  const zkApp = new ActionCounter(zkAppKey.toPublicKey());

  async function send(sender: Mina.TestPublicKey, body: () => Promise<void>) {
    const tx = await Mina.transaction(sender, body);
    await tx.prove();
    await tx.sign([sender.key]).send();
  }

  before(async () => {
    if (proofsEnabled) await ActionCounter.compile();
    const local = await Mina.LocalBlockchain({ proofsEnabled });
    Mina.setActiveInstance(local);
    users = local.testAccounts.slice(0, 3);

    const tx = await Mina.transaction(users[0], async () => {
      AccountUpdate.fundNewAccount(users[0]);
      await zkApp.deploy();
    });
    await tx.prove();
    await tx.sign([users[0].key, zkAppKey]).send();
  });

  it('collects increments from several users without touching state', async () => {
    for (const user of users) await send(user, () => zkApp.increment());
    await send(users[0], () => zkApp.incrementTwice());
    assert.deepEqual(zkApp.counter.get(), Field(0));
  });

  it('folds all pending actions into the counter', async () => {
    await send(users[1], () => zkApp.rollup());
    assert.deepEqual(zkApp.counter.get(), Field(5));
  });

  it('is idempotent once caught up', async () => {
    await send(users[2], () => zkApp.rollup());
    assert.deepEqual(zkApp.counter.get(), Field(5));
  });
});
