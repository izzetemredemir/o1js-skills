import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { AccountUpdate, Field, Mina, PrivateKey } from 'o1js';
import { proofsEnabled } from '../shared/test-utils.js';
import { SumProgram, SumSettlement } from './SumProgram.js';

describe('SumProgram + SumSettlement', () => {
  let sender: Mina.TestPublicKey;
  const zkAppKey = PrivateKey.random();
  const zkApp = new SumSettlement(zkAppKey.toPublicKey());

  before(async () => {
    // Compile the program before the contract that verifies its proofs.
    await SumProgram.compile({ proofsEnabled });
    if (proofsEnabled) await SumSettlement.compile();
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

  it('provers resolve to { proof }, and verify() is async', async () => {
    const { proof } = await SumProgram.start(Field(0));
    assert.deepEqual(proof.publicOutput, Field(0));
    assert.equal(await SumProgram.verify(proof), true);
  });

  it('settles a recursive chain on-chain', async () => {
    const { proof: p0 } = await SumProgram.start(Field(0));
    const { proof: p1 } = await SumProgram.add(Field(0), p0, Field(5));
    const { proof: p2 } = await SumProgram.add(Field(0), p1, Field(7));
    assert.deepEqual(p2.publicOutput, Field(12));

    const tx = await Mina.transaction(sender, async () => {
      await zkApp.settle(p2);
    });
    await tx.prove();
    await tx.sign([sender.key]).send();
    assert.deepEqual(zkApp.total.get(), Field(12));
  });

  it('refuses a chain that does not start from the on-chain total', async () => {
    const { proof: stale } = await SumProgram.start(Field(0));
    await assert.rejects(
      Mina.transaction(sender, async () => {
        await zkApp.settle(stale);
      })
    );
  });
});
