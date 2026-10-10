import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { AccountUpdate, Bool, Field, Mina, Poseidon, PrivateKey, Provable, UInt64 } from 'o1js';
import { proofsEnabled } from '../shared/test-utils.js';
import { BareGet, DoubleDispatch, Pitfalls, ToBooleanInCircuit } from './Pitfalls.js';

describe('contract pitfalls', () => {
  let sender: Mina.TestPublicKey;
  const key = PrivateKey.random();
  const zkApp = new Pitfalls(key.toPublicKey());

  async function call(body: () => Promise<unknown>) {
    const tx = await Mina.transaction(sender, async () => {
      await body();
    });
    await tx.prove();
    await tx.sign([sender.key]).send();
  }

  before(async () => {
    if (proofsEnabled) await Pitfalls.compile();
    const local = await Mina.LocalBlockchain({ proofsEnabled });
    Mina.setActiveInstance(local);
    [sender] = local.testAccounts;
    const tx = await Mina.transaction(sender, async () => {
      AccountUpdate.fundNewAccount(sender);
      await zkApp.deploy();
    });
    await tx.prove();
    await tx.sign([sender.key, key]).send();
  });

  it('JS `if` on a Bool runs the branch even when the flag is false', async () => {
    await call(() => zkApp.jsIf(Bool(false), Field(7)));
    assert.deepEqual(zkApp.x.get(), Field(7));
  });

  it('Provable.if respects the flag', async () => {
    await call(() => zkApp.provableIf(Bool(false), Field(99)));
    assert.deepEqual(zkApp.x.get(), Field(7));
  });

  it('an unasserted equals() accepts a wrong guess', async () => {
    await call(() => zkApp.unassertedEquals(Field(12345)));
  });

  it('assertEquals() rejects a wrong guess', async () => {
    await assert.rejects(call(() => zkApp.assertedEquals(Field(12345))));
  });

  it('get() after set() returns the value from before the set', async () => {
    let returned: Field | undefined;
    await call(async () => {
      returned = await zkApp.readAfterWrite();
    });
    assert.deepEqual(returned, Field(7));
    assert.deepEqual(zkApp.x.get(), Field(8));
  });

  it('get() without a precondition stops the contract from compiling', async () => {
    await assert.rejects(BareGet.analyzeMethods(), /without adding a precondition/);
  });

  it('toBoolean() inside a method fails as soon as the circuit is analysed', async () => {
    await assert.rejects(ToBooleanInCircuit.analyzeMethods());
  });
});

describe('reducer pitfall', () => {
  it('two dispatches per method with the default maxActionsPerUpdate make rollup impossible', async () => {
    const local = await Mina.LocalBlockchain({ proofsEnabled: false });
    Mina.setActiveInstance(local);
    const [sender] = local.testAccounts;
    const key = PrivateKey.random();
    const zkApp = new DoubleDispatch(key.toPublicKey());
    const deploy = await Mina.transaction(sender, async () => {
      AccountUpdate.fundNewAccount(sender);
      await zkApp.deploy();
    });
    await deploy.sign([sender.key, key]).send();

    const dispatch = await Mina.transaction(sender, () => zkApp.incrementTwice());
    await dispatch.prove();
    await dispatch.sign([sender.key]).send();

    await assert.rejects(async () => {
      const rollup = await Mina.transaction(sender, () => zkApp.rollup());
      await rollup.prove();
      await rollup.sign([sender.key]).send();
    });
  });
});

describe('value pitfalls', () => {
  it('Poseidon.hash zero-pads: [x] and [x, 0] collide, hashAnyLength does not', () => {
    const x = Field(5);
    assert.deepEqual(Poseidon.hash([x]), Poseidon.hash([x, Field(0)]));
    assert.deepEqual(Poseidon.hash([]), Poseidon.hash([Field(0)]));
    assert.notDeepEqual(Poseidon.hashAnyLength([x]), Poseidon.hashAnyLength([x, Field(0)]));
  });

  it('Field wraps around the modulus; UInt64 throws instead', () => {
    assert.equal(Field(0).sub(1).toBigInt(), Field.ORDER - 1n);
    assert.throws(() => UInt64.from(0).sub(1));
  });

  it('Field.div is modular inversion, not integer division', () => {
    const q = Field(7).div(2);
    assert.notEqual(q.toBigInt(), 3n);
    assert.deepEqual(q.mul(2), Field(7));
    assert.deepEqual(UInt64.from(7).div(2), UInt64.from(3));
  });

  it('Provable.if evaluates both branches, so a guarded division by zero still fails', async () => {
    await assert.rejects(
      Provable.runAndCheck(() => {
        const d = Provable.witness(Field, () => 0n);
        Provable.if(d.equals(0), Field(0), Field(10).div(d));
      })
    );
    await Provable.runAndCheck(() => {
      const d = Provable.witness(Field, () => 0n);
      const safe = Provable.if(d.equals(0), Field(1), d);
      Provable.if(d.equals(0), Field(0), Field(10).div(safe));
    });
  });
});
