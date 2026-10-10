import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { AccountUpdate, Int64, Mina, PrivateKey, TokenId, UInt64 } from 'o1js';
import { authName, permissionsOf, proofsEnabled } from '../shared/test-utils.js';
import { KeyHolderToken, LeakyToken, SimpleToken } from './SimpleToken.js';

describe('SimpleToken', () => {
  let admin: Mina.TestPublicKey, alice: Mina.TestPublicKey, bob: Mina.TestPublicKey;
  const tokenKey = PrivateKey.random();
  const token = new SimpleToken(tokenKey.toPublicKey());
  const tokenId = token.deriveTokenId();
  const balanceOf = (who: Mina.TestPublicKey) => Mina.getBalance(who, tokenId).toBigInt();

  before(async () => {
    if (proofsEnabled) await SimpleToken.compile();
    const local = await Mina.LocalBlockchain({ proofsEnabled });
    Mina.setActiveInstance(local);
    [admin, alice, bob] = local.testAccounts;

    const tx = await Mina.transaction(admin, async () => {
      AccountUpdate.fundNewAccount(admin);
      await token.deploy({ admin });
    });
    await tx.prove();
    await tx.sign([admin.key, tokenKey]).send();
  });

  it('requires a proof to access the token account', () => {
    assert.equal(authName(permissionsOf(token.address).access), 'proof');
  });

  it('lets the admin mint to a new token account (which costs an account creation fee)', async () => {
    const tx = await Mina.transaction(admin, async () => {
      AccountUpdate.fundNewAccount(admin);
      await token.mint(alice, UInt64.from(100));
    });
    await tx.prove();
    await tx.sign([admin.key]).send();
    assert.equal(balanceOf(alice), 100n);
  });

  it('rejects minting by anyone else', async () => {
    await assert.rejects(
      Mina.transaction(alice, async () => {
        await token.mint(alice, UInt64.from(1));
      })
    );
  });

  it('transfers between holders', async () => {
    const tx = await Mina.transaction(alice, async () => {
      AccountUpdate.fundNewAccount(alice);
      await token.transfer(alice, bob, UInt64.from(30));
    });
    await tx.prove();
    await tx.sign([alice.key]).send();
    assert.equal(balanceOf(alice), 70n);
    assert.equal(balanceOf(bob), 30n);
  });

  it('rejects minting that bypasses the contract', async () => {
    const tx = await Mina.transaction(alice, async () => {
      await mintBypassingContract(AccountUpdate.create(token.address), alice, 1_000_000);
    });
    await assert.rejects(tx.sign([alice.key]).send(), /Update_not_permitted_access/);
    assert.equal(balanceOf(alice), 70n);
  });

  it('refuses token movements that do not balance out', async () => {
    await assert.rejects(
      Mina.transaction(alice, async () => {
        const free = AccountUpdate.default(alice, tokenId);
        free.balanceChange = Int64.from(1_000);
        await token.approveAccountUpdate(free);
      })
    );
  });
});

/** Mints by creating the token owner's account update directly, so approveBase never runs. */
async function mintBypassingContract(owner: AccountUpdate, to: Mina.TestPublicKey, amount: number) {
  const minted = AccountUpdate.default(to, TokenId.derive(owner.publicKey));
  owner.approve(minted);
  minted.balance.addInPlace(UInt64.from(amount));
}

describe('KeyHolderToken (anti-example)', () => {
  it('keeps access: proofOrSignature, so the contract key can mint without approveBase', async () => {
    const local = await Mina.LocalBlockchain({ proofsEnabled: false });
    Mina.setActiveInstance(local);
    const [deployer] = local.testAccounts;
    const key = PrivateKey.random();
    const token = new KeyHolderToken(key.toPublicKey());

    const deployTx = await Mina.transaction(deployer, async () => {
      AccountUpdate.fundNewAccount(deployer);
      await token.deploy();
    });
    await deployTx.sign([deployer.key, key]).send();
    assert.equal(authName(permissionsOf(token.address).access), 'proofOrSignature');

    const mintTx = await Mina.transaction(deployer, async () => {
      AccountUpdate.fundNewAccount(deployer);
      await mintBypassingContract(AccountUpdate.createSigned(token.address), deployer, 1_000_000);
    });
    await mintTx.sign([deployer.key, key]).send();
    assert.equal(Mina.getBalance(deployer, token.deriveTokenId()).toBigInt(), 1_000_000n);
  });
});

describe('LeakyToken (anti-example)', () => {
  it('ends up with access: none, so anyone can mint without the contract', async () => {
    const local = await Mina.LocalBlockchain({ proofsEnabled: false });
    Mina.setActiveInstance(local);
    const [deployer, attacker] = local.testAccounts;
    const key = PrivateKey.random();
    const leaky = new LeakyToken(key.toPublicKey());

    const deployTx = await Mina.transaction(deployer, async () => {
      AccountUpdate.fundNewAccount(deployer);
      await leaky.deploy();
    });
    await deployTx.sign([deployer.key, key]).send();
    assert.equal(authName(permissionsOf(leaky.address).access), 'none');

    // No proof and no signature for the token contract: its account update is simply created by the attacker.
    const exploit = await Mina.transaction(attacker, async () => {
      AccountUpdate.fundNewAccount(attacker);
      await mintBypassingContract(AccountUpdate.create(leaky.address), attacker, 1_000_000);
    });
    await exploit.sign([attacker.key]).send();
    assert.equal(Mina.getBalance(attacker, TokenId.derive(leaky.address)).toBigInt(), 1_000_000n);
  });
});
