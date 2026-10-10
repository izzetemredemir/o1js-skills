import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { AccountUpdate, Int64, Mina, Permissions, PrivateKey, PublicKey, UInt64 } from 'o1js';
import { MintEvent, Token, TokenErrors } from './Token.js';

// Fast logic tests by default. Set PROOFS=1 to compile the contract and prove every transaction; do that
// before any deployment, because some problems only show up when compiling.
const proofsEnabled = process.env.PROOFS === '1';

type AuthRequired = ReturnType<typeof Permissions.none>;

/** Human-readable name of a permission. */
function authName(auth: AuthRequired) {
  const constant = auth.constant.toBoolean();
  const necessary = auth.signatureNecessary.toBoolean();
  const sufficient = auth.signatureSufficient.toBoolean();
  if (constant) return sufficient ? 'none' : 'impossible';
  if (necessary) return sufficient ? 'signature' : 'proofAndSignature';
  return sufficient ? 'proofOrSignature' : 'proof';
}

/** Validator for assert.rejects: the error message contains `text`. */
function mentions(text: string) {
  return (err: unknown) => {
    assert.ok(err instanceof Error, `expected an Error, got ${String(err)}`);
    assert.ok(err.message.includes(text), `expected "${text}" in: ${err.message}`);
    return true;
  };
}

describe('Token', () => {
  let deployer: Mina.TestPublicKey;
  let admin: Mina.TestPublicKey;
  let alice: Mina.TestPublicKey;
  let bob: Mina.TestPublicKey;
  let mallory: Mina.TestPublicKey;

  const tokenKey = PrivateKey.random();
  const token = new Token(tokenKey.toPublicKey());
  const tokenId = token.deriveTokenId();
  const balanceOf = (who: PublicKey) => Mina.getBalance(who, tokenId).toBigInt();
  const hasTokenAccount = (who: PublicKey) => Mina.hasAccount(who, tokenId);

  /** Credits `to` under a hand-built token-owner update, so neither `mint` nor `approveBase` runs. */
  function mintAround(owner: AccountUpdate, to: PublicKey, amount: number) {
    const minted = AccountUpdate.default(to, tokenId);
    owner.approve(minted);
    minted.balance.addInPlace(UInt64.from(amount));
  }

  before(async () => {
    if (proofsEnabled) await Token.compile();
    const local = await Mina.LocalBlockchain({ proofsEnabled });
    Mina.setActiveInstance(local);
    [deployer, admin, alice, bob, mallory] = local.testAccounts;
  });

  it('deploys with the admin chosen at deploy time and locked-down permissions', async () => {
    const tx = await Mina.transaction(deployer, async () => {
      AccountUpdate.fundNewAccount(deployer);
      await token.deploy({ admin, symbol: 'MYT' });
    });
    await tx.prove();
    await tx.sign([deployer.key, tokenKey]).send();

    assert.equal(token.admin.get().toBase58(), admin.toBase58());
    const { permissions } = Mina.getAccount(token.address);
    assert.equal(authName(permissions.access), 'proof');
    assert.equal(authName(permissions.editState), 'proof');
    assert.equal(authName(permissions.setVerificationKey.auth), 'impossible');
    assert.equal(authName(permissions.setPermissions), 'impossible');
  });

  it('lets the admin mint to a new holder (paying the token account creation fee)', async () => {
    const tx = await Mina.transaction(admin, async () => {
      AccountUpdate.fundNewAccount(admin);
      await token.mint(alice, UInt64.from(1_000));
    });
    await tx.prove();
    await tx.sign([admin.key]).send();

    assert.equal(balanceOf(alice), 1_000n);
    const [event] = await token.fetchEvents();
    assert.equal(event.type, 'mint');
    const minted = event.event.data as unknown as MintEvent;
    assert.equal(minted.to.toBase58(), alice.toBase58());
    assert.equal(minted.amount.toBigInt(), 1_000n);
  });

  it('rejects a mint by anyone other than the admin', async () => {
    await assert.rejects(
      Mina.transaction(mallory, async () => {
        AccountUpdate.fundNewAccount(mallory);
        await token.mint(mallory, UInt64.from(1_000_000));
      }),
      mentions(TokenErrors.notAdmin)
    );
    assert.equal(hasTokenAccount(mallory), false);
  });

  it('lets holders transfer to each other', async () => {
    const tx = await Mina.transaction(alice, async () => {
      AccountUpdate.fundNewAccount(alice); // bob's token account is new
      await token.transfer(alice, bob, UInt64.from(300));
    });
    await tx.prove();
    await tx.sign([alice.key]).send();
    assert.equal(balanceOf(alice), 700n);
    assert.equal(balanceOf(bob), 300n);

    const back = await Mina.transaction(bob, async () => {
      await token.transfer(bob, alice, UInt64.from(100));
    });
    await back.prove();
    await back.sign([bob.key]).send();
    assert.equal(balanceOf(alice), 800n);
    assert.equal(balanceOf(bob), 200n);
  });

  it("rejects moving a holder's tokens without the holder's signature", async () => {
    await assert.rejects(async () => {
      const tx = await Mina.transaction(mallory, async () => {
        AccountUpdate.fundNewAccount(mallory);
        await token.transfer(alice, mallory, UInt64.from(800));
      });
      await tx.prove();
      await tx.sign([mallory.key]).send();
    }, /signature/i);
    assert.equal(balanceOf(alice), 800n);
    assert.equal(hasTokenAccount(mallory), false);
  });

  it('rejects minting through an unauthorized token-owner update', async () => {
    const tx = await Mina.transaction(mallory, async () => {
      mintAround(AccountUpdate.create(token.address), bob, 1_000_000);
    });
    await assert.rejects(tx.sign([mallory.key]).send(), /Update_not_permitted_access/);
    assert.equal(balanceOf(bob), 200n);
  });

  it("rejects minting signed with the token contract's own private key", async () => {
    await assert.rejects(async () => {
      const tx = await Mina.transaction(mallory, async () => {
        mintAround(AccountUpdate.createSigned(token.address), bob, 1_000_000);
      });
      await tx.sign([mallory.key, tokenKey]).send();
    }, /Update_not_permitted|incrementNonce/);
    assert.equal(balanceOf(bob), 200n);
  });

  it('refuses token movements that create tokens', async () => {
    await assert.rejects(
      Mina.transaction(mallory, async () => {
        const credit = AccountUpdate.default(bob, tokenId);
        credit.balanceChange = Int64.from(1_000_000);
        await token.approveAccountUpdate(credit);
      }),
      mentions(TokenErrors.flashMint)
    );
  });

  it('refuses a credit that comes before its debit (flash mint)', async () => {
    await assert.rejects(
      Mina.transaction(alice, async () => {
        const credit = AccountUpdate.default(bob, tokenId);
        credit.balanceChange = Int64.from(100);
        const debit = AccountUpdate.default(alice, tokenId);
        debit.balanceChange = Int64.from(100).neg();
        debit.requireSignature();
        await token.approveAccountUpdates([credit, debit]);
      }),
      mentions(TokenErrors.flashMint)
    );
  });

  it("refuses updates that lock a holder's token account", async () => {
    await assert.rejects(
      Mina.transaction(bob, async () => {
        const update = AccountUpdate.default(bob, tokenId);
        update.requireSignature();
        update.account.permissions.set({ ...Permissions.default(), receive: Permissions.impossible() });
        await token.approveAccountUpdate(update);
      }),
      mentions(TokenErrors.holderPermissions)
    );
  });

  it('cannot be redeployed to replace the admin, even with the token contract key', async () => {
    await assert.rejects(async () => {
      const tx = await Mina.transaction(mallory, async () => {
        await token.deploy({ admin: mallory, symbol: 'EVIL' });
      });
      await tx.prove();
      await tx.sign([mallory.key, tokenKey]).send();
    });
    assert.equal(token.admin.get().toBase58(), admin.toBase58());
    assert.equal(authName(Mina.getAccount(token.address).permissions.access), 'proof');
  });
});
