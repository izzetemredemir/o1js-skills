import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { AccountUpdate, Field, Mina, PrivateKey } from 'o1js';
import { Counter } from './Counter.js';

const proofsEnabled = process.env.PROOFS === '1';

describe('Counter', () => {
  let sender: Mina.TestPublicKey;
  let zkAppKey: PrivateKey;
  let zkApp: Counter;

  before(async () => {
    if (proofsEnabled) await Counter.compile();
    const local = await Mina.LocalBlockchain({ proofsEnabled });
    Mina.setActiveInstance(local);
    [sender] = local.testAccounts;

    zkAppKey = PrivateKey.random();
    zkApp = new Counter(zkAppKey.toPublicKey());
    const tx = await Mina.transaction(sender, async () => {
      AccountUpdate.fundNewAccount(sender);
      await zkApp.deploy();
    });
    await tx.prove();
    await tx.sign([sender.key, zkAppKey]).send();
  });

  it('starts at zero', () => {
    assert.deepEqual(zkApp.count.get(), Field(0));
  });

  it('increments', async () => {
    const tx = await Mina.transaction(sender, async () => {
      await zkApp.increment();
    });
    await tx.prove();
    await tx.sign([sender.key]).send();
    assert.deepEqual(zkApp.count.get(), Field(1));
  });

  it('emits an event that fetchEvents() returns', async () => {
    const events = await zkApp.fetchEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'incremented');
    assert.deepEqual(events[0].event.data, Field(1));
  });
});
