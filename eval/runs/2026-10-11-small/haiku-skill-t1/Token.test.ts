import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { AccountUpdate, Mina, Permissions, PrivateKey, UInt64 } from 'o1js';
import { Token } from './Token.js';

describe('Token', () => {
  let admin: Mina.TestPublicKey;
  let alice: Mina.TestPublicKey;
  let bob: Mina.TestPublicKey;
  const tokenKey = PrivateKey.random();
  const token = new Token(tokenKey.toPublicKey());
  const tokenId = token.deriveTokenId();
  const balanceOf = (who: Mina.TestPublicKey) => Mina.getBalance(who, tokenId).toBigInt();

  before(async () => {
    const local = await Mina.LocalBlockchain({ proofsEnabled: false });
    Mina.setActiveInstance(local);
    [admin, alice, bob] = local.testAccounts;

    const deployTx = await Mina.transaction(admin, async () => {
      AccountUpdate.fundNewAccount(admin);
      await token.deploy({ admin: admin });
    });
    await deployTx.prove();
    await deployTx.sign([admin.key, tokenKey]).send();
  });

  it('deploys with the admin set and the token account locked behind proofs', () => {
    assert.equal(token.admin.get().toBase58(), admin.toBase58());
    assert.deepEqual(Mina.getAccount(token.address).permissions.access, Permissions.proof());
  });

  it('lets the admin mint to a new holder', async () => {
    const tx = await Mina.transaction(admin, async () => {
      AccountUpdate.fundNewAccount(admin);
      await token.mint(alice, UInt64.from(100));
    });
    await tx.prove();
    await tx.sign([admin.key]).send();
    assert.equal(balanceOf(alice), 100n);
  });

  it('rejects a mint by a non-admin', async () => {
    await assert.rejects(async () => {
      const tx = await Mina.transaction(alice, async () => {
        await token.mint(alice, UInt64.from(1_000));
      });
      await tx.prove();
      await tx.sign([alice.key]).send();
    });
    assert.equal(balanceOf(alice), 100n);
  });

  it('transfers tokens between holders', async () => {
    const tx = await Mina.transaction(alice, async () => {
      AccountUpdate.fundNewAccount(alice);
      await token.transfer(alice, bob, UInt64.from(30));
    });
    await tx.prove();
    await tx.sign([alice.key]).send();
    assert.equal(balanceOf(alice), 70n);
    assert.equal(balanceOf(bob), 30n);
  });
});
