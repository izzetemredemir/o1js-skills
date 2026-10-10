import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { AccountUpdate, Mina, PrivateKey, TokenId, UInt64 } from 'o1js';
import { Token } from './Token.js';

const proofsEnabled = process.env.PROOFS === '1';

describe('Token', () => {
  let admin: Mina.TestPublicKey, alice: Mina.TestPublicKey, bob: Mina.TestPublicKey;
  const tokenKey = PrivateKey.random();
  const token = new Token(tokenKey.toPublicKey());
  const tokenId = token.deriveTokenId();
  const balanceOf = (who: Mina.TestPublicKey) => Mina.getBalance(who, tokenId).toBigInt();

  before(async () => {
    if (proofsEnabled) await Token.compile();
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

  it('deploys with the admin and locked-down permissions', () => {
    assert.equal(token.admin.get().toBase58(), admin.toBase58());
    const { access } = Mina.getAccount(token.address).permissions;
    // proof(): not satisfiable by a signature or by "none"
    assert.equal(access.signatureSufficient.toBoolean(), false);
    assert.equal(access.proofSufficient.toBoolean(), true);
  });

  it('lets the admin mint', async () => {
    const tx = await Mina.transaction(admin, async () => {
      AccountUpdate.fundNewAccount(admin); // alice's token account is new
      await token.mint(alice, UInt64.from(100));
    });
    await tx.prove();
    await tx.sign([admin.key]).send();
    assert.equal(balanceOf(alice), 100n);
  });

  it('rejects minting by a non-admin', async () => {
    await assert.rejects(
      (async () => {
        const tx = await Mina.transaction(alice, async () => {
          await token.mint(alice, UInt64.from(1));
        });
        await tx.prove();
        await tx.sign([alice.key]).send();
      })()
    );
    assert.equal(balanceOf(alice), 100n);
  });

  it('transfers between holders', async () => {
    const tx = await Mina.transaction(alice, async () => {
      AccountUpdate.fundNewAccount(alice); // bob's token account is new
      await token.transfer(alice, bob, UInt64.from(30));
    });
    await tx.prove();
    await tx.sign([alice.key]).send();
    assert.equal(balanceOf(alice), 70n);
    assert.equal(balanceOf(bob), 30n);
  });

  it('rejects minting that bypasses the contract', async () => {
    await assert.rejects(
      (async () => {
        const tx = await Mina.transaction(alice, async () => {
          const owner = AccountUpdate.create(token.address);
          const minted = AccountUpdate.default(alice, TokenId.derive(token.address));
          owner.approve(minted);
          minted.balance.addInPlace(UInt64.from(1_000_000));
        });
        await tx.sign([alice.key]).send();
      })(),
      /Update_not_permitted_access/
    );
    assert.equal(balanceOf(alice), 70n);
  });
});
