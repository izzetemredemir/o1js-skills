import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { AccountUpdate, Field, Mina, Permissions, PrivateKey } from 'o1js';
import { authName, permissionsOf, proofsEnabled } from '../shared/test-utils.js';
import { CounterV1, CounterV2 } from './Upgradable.js';

describe('upgrading a deployed contract', () => {
  let owner: Mina.TestPublicKey;
  const zkAppKey = PrivateKey.random();
  const address = zkAppKey.toPublicKey();

  async function send(body: () => Promise<void>, keys: PrivateKey[] = []) {
    const tx = await Mina.transaction(owner, body);
    await tx.prove();
    await tx.sign([owner.key, ...keys]).send();
  }

  before(async () => {
    if (proofsEnabled) {
      await CounterV1.compile();
      await CounterV2.compile();
    }
    const local = await Mina.LocalBlockchain({ proofsEnabled });
    Mina.setActiveInstance(local);
    [owner] = local.testAccounts;

    await send(async () => {
      AccountUpdate.fundNewAccount(owner);
      await new CounterV1(address).deploy();
    }, [zkAppKey]);
    await send(() => new CounterV1(address).bump());
  });

  it('calling deploy() again resets permissions to the defaults', async () => {
    await send(async () => {
      AccountUpdate.createSigned(address).account.permissions.set({
        ...Permissions.default(),
        setZkappUri: Permissions.impossible(),
      });
    }, [zkAppKey]);
    assert.equal(authName(permissionsOf(address).setZkappUri), 'impossible');

    await send(() => new CounterV1(address).deploy(), [zkAppKey]);
    assert.equal(authName(permissionsOf(address).setZkappUri), 'signature');
    assert.deepEqual(new CounterV1(address).count.get(), Field(1), 'state survives, permissions do not');
  });

  it('upgrades by setting the new verification key in a signed account update', { skip: !proofsEnabled }, async () => {
    const { verificationKey } = await CounterV2.compile();
    await send(async () => {
      AccountUpdate.createSigned(address).account.verificationKey.set(verificationKey);
    }, [zkAppKey]);

    await send(() => new CounterV2(address).bump());
    assert.deepEqual(new CounterV2(address).count.get(), Field(11));
  });
});
