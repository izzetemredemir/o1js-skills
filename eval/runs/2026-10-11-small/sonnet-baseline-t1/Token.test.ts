import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AccountUpdate, Mina, PrivateKey, PublicKey, UInt64 } from 'o1js';
import { Token } from './Token.js';

describe('Token', () => {
  let deployer: Mina.TestPublicKey;
  let admin: Mina.TestPublicKey;
  let alice: Mina.TestPublicKey;
  let bob: Mina.TestPublicKey;
  let attacker: Mina.TestPublicKey;
  let zkAppKey: PrivateKey;
  let zkApp: Token;

  const balance = (addr: PublicKey) =>
    Mina.getBalance(addr, zkApp.deriveTokenId()).toBigInt();

  before(async () => {
    const Local = await Mina.LocalBlockchain({ proofsEnabled: true });
    Mina.setActiveInstance(Local);
    [deployer, admin, alice, bob, attacker] = Local.testAccounts;

    zkAppKey = PrivateKey.random();
    zkApp = new Token(zkAppKey.toPublicKey());

    await Token.compile();
  });

  it('deploys with the chosen admin', async () => {
    const tx = await Mina.transaction(deployer, async () => {
      AccountUpdate.fundNewAccount(deployer);
      await zkApp.deploy({ admin });
    });
    await tx.prove();
    await tx.sign([deployer.key, zkAppKey]).send();

    assert.equal(zkApp.admin.get().toBase58(), admin.toBase58());
  });

  it('lets the admin mint', async () => {
    const tx = await Mina.transaction(deployer, async () => {
      AccountUpdate.fundNewAccount(deployer);
      await zkApp.mint(alice, UInt64.from(1000));
    });
    await tx.prove();
    await tx.sign([deployer.key, admin.key]).send();

    assert.equal(balance(alice), 1000n);
  });

  it('rejects a mint by a non-admin', async () => {
    await assert.rejects(async () => {
      const tx = await Mina.transaction(attacker, async () => {
        AccountUpdate.fundNewAccount(attacker);
        await zkApp.mint(attacker, UInt64.from(1_000_000));
      });
      await tx.prove();
      // the attacker can only sign for itself, the admin signature is missing
      await tx.sign([attacker.key]).send();
    });

    assert.equal(balance(alice), 1000n);
    assert.throws(() => balance(attacker));
  });

  it('transfers between holders', async () => {
    const tx = await Mina.transaction(alice, async () => {
      AccountUpdate.fundNewAccount(alice);
      await zkApp.transfer(alice, bob, UInt64.from(300));
    });
    await tx.prove();
    await tx.sign([alice.key]).send();

    assert.equal(balance(alice), 700n);
    assert.equal(balance(bob), 300n);
  });

  it('rejects a transfer signed by someone other than the holder', async () => {
    await assert.rejects(async () => {
      const tx = await Mina.transaction(attacker, async () => {
        await zkApp.transfer(alice, attacker, UInt64.from(1));
      });
      await tx.prove();
      await tx.sign([attacker.key]).send();
    });
    assert.equal(balance(alice), 700n);
  });
});
