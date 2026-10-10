import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { AccountUpdate, Field, Mina, PrivateKey } from 'o1js';
import { proofsEnabled } from '../shared/test-utils.js';
import { FullState, Noop, TooMuchState } from './Limits.js';

describe('Mesa limits', () => {
  let payer: Mina.TestPublicKey;
  const noopKey = PrivateKey.random();
  const noop = new Noop(noopKey.toPublicKey());

  before(async () => {
    if (proofsEnabled) {
      await Noop.compile();
      await FullState.compile();
    }
    const local = await Mina.LocalBlockchain({ proofsEnabled });
    Mina.setActiveInstance(local);
    [payer] = local.testAccounts;
    const tx = await Mina.transaction(payer, async () => {
      AccountUpdate.fundNewAccount(payer);
      await noop.deploy();
    });
    await tx.prove();
    await tx.sign([payer.key, noopKey]).send();
  });

  async function callNoop(times: number) {
    const tx = await Mina.transaction(payer, async () => {
      for (let i = 0; i < times; i++) await noop.noop();
    });
    await tx.prove();
    return tx.sign([payer.key]).send();
  }

  it('fits the fee payer plus 15 proof-authorized account updates (16 segments)', async () => {
    await callNoop(15);
  });

  it('rejects a 17th segment', async () => {
    await assert.rejects(callNoop(16), /maximum number of segments per transaction is 16/);
  });

  it('allows 32 on-chain state fields', async () => {
    const key = PrivateKey.random();
    const zkApp = new FullState(key.toPublicKey());
    const tx = await Mina.transaction(payer, async () => {
      AccountUpdate.fundNewAccount(payer);
      await zkApp.deploy();
      zkApp.data.set(Array.from({ length: 32 }, (_, i) => Field(i)));
    });
    await tx.prove();
    await tx.sign([payer.key, key]).send();
    assert.deepEqual(zkApp.data.get()[31], Field(31));
  });

  it('rejects a 33rd state field', async () => {
    const key = PrivateKey.random();
    await assert.rejects(async () => {
      if (proofsEnabled) await TooMuchState.compile();
      await Mina.transaction(payer, async () => {
        AccountUpdate.fundNewAccount(payer);
        await new TooMuchState(key.toPublicKey()).deploy();
      });
    }, /only a total of 32 field elements of state are supported/);
  });
});
