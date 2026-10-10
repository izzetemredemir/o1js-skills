import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { AccountUpdate, Mina, Permissions, PrivateKey, UInt64 } from 'o1js';
import { proofsEnabled } from '../shared/test-utils.js';
import { SimpleToken } from './SimpleToken.js';
import { StrictToken, transferHalves } from './StrictToken.js';

for (const Token of [SimpleToken, StrictToken]) {
  const strict = Token === StrictToken;

  describe(`${Token.name}: per-update checks`, () => {
    let admin: Mina.TestPublicKey, alice: Mina.TestPublicKey, bob: Mina.TestPublicKey;
    const key = PrivateKey.random();
    const token = new Token(key.toPublicKey());
    const tokenId = token.deriveTokenId();

    async function send(sender: Mina.TestPublicKey, body: () => Promise<void>) {
      const tx = await Mina.transaction(sender, body);
      await tx.prove();
      await tx.sign([sender.key]).send();
    }

    before(async () => {
      if (proofsEnabled) await Token.compile();
      const local = await Mina.LocalBlockchain({ proofsEnabled });
      Mina.setActiveInstance(local);
      [admin, alice, bob] = local.testAccounts;
      const deployTx = await Mina.transaction(admin, async () => {
        AccountUpdate.fundNewAccount(admin);
        await token.deploy({ admin });
      });
      await deployTx.prove();
      await deployTx.sign([admin.key, key]).send();

      // mint reads the admin from state, so it can't share a transaction with deploy
      await send(admin, async () => {
        AccountUpdate.fundNewAccount(admin, 2);
        await token.mint(alice, UInt64.from(100));
        await token.mint(bob, UInt64.from(100));
      });
    });

    it('accepts a normal transfer (debit, then credit)', async () => {
      await send(alice, async () => {
        const { debit, credit } = transferHalves(tokenId, alice, bob, 10);
        await token.approveAccountUpdates([debit, credit]);
      });
      assert.equal(Mina.getBalance(bob, tokenId).toBigInt(), 110n);
    });

    it(`${strict ? 'rejects' : 'accepts'} crediting before debiting (flash mint)`, async () => {
      const attempt = send(alice, async () => {
        const { debit, credit } = transferHalves(tokenId, alice, bob, 10);
        await token.approveAccountUpdates([credit, debit]);
      });
      if (strict) await assert.rejects(attempt, /credited before/);
      else await attempt;
    });

    it(`${strict ? 'rejects' : 'accepts'} a holder locking their token account`, async () => {
      const attempt = send(bob, async () => {
        const lock = AccountUpdate.default(bob, tokenId);
        lock.requireSignature();
        lock.account.permissions.set({ ...Permissions.default(), receive: Permissions.impossible() });
        await token.approveAccountUpdate(lock);
      });
      if (strict) await assert.rejects(attempt, /keep access and receive/);
      else await attempt;
    });
  });
}
