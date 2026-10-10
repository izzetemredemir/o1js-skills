import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { AccountUpdate, Mina, PrivateKey, UInt64 } from 'o1js';
import { proofsEnabled } from '../shared/test-utils.js';
import { OffchainLedger, offchainState } from './OffchainLedger.js';

describe('OffchainLedger (Experimental.OffchainState)', () => {
  let admin: Mina.TestPublicKey, alice: Mina.TestPublicKey, bob: Mina.TestPublicKey, carol: Mina.TestPublicKey;
  const key = PrivateKey.random();
  const ledger = new OffchainLedger(key.toPublicKey());
  const balance = async (who: Mina.TestPublicKey) => (await ledger.balanceOf(who)).toBigInt();

  async function send(sender: Mina.TestPublicKey, body: () => Promise<void>) {
    const tx = await Mina.transaction(sender, body);
    await tx.prove();
    await tx.sign([sender.key]).send();
  }

  async function settle() {
    const proof = await ledger.offchainState.createSettlementProof();
    await send(admin, () => ledger.settle(proof));
  }

  before(async () => {
    const local = await Mina.LocalBlockchain({ proofsEnabled });
    Mina.setActiveInstance(local);
    [admin, alice, bob, carol] = local.testAccounts;
    ledger.offchainState.setContractInstance(ledger);
    if (proofsEnabled) {
      await offchainState.compile();
      await OffchainLedger.compile();
    }
    const tx = await Mina.transaction(admin, async () => {
      AccountUpdate.fundNewAccount(admin);
      await ledger.deploy();
    });
    await tx.prove();
    await tx.sign([admin.key, key]).send();
  });

  it('applies writes only after settlement', async () => {
    await send(admin, () => ledger.mint(alice, UInt64.from(1000)));
    assert.equal(await balance(alice), 0n);
    await settle();
    assert.equal(await balance(alice), 1000n);
  });

  it('settles a transfer', async () => {
    await send(alice, () => ledger.transfer(alice, bob, UInt64.from(100)));
    await settle();
    assert.equal(await balance(alice), 900n);
    assert.equal(await balance(bob), 100n);
  });

  it('silently drops a transfer whose `from` value went stale before settlement', async () => {
    // Both transactions read alice = 900 and both are accepted on-chain.
    await send(alice, () => ledger.transfer(alice, bob, UInt64.from(600)));
    await send(alice, () => ledger.transfer(alice, carol, UInt64.from(600)));
    await settle();
    assert.equal(await balance(alice), 300n);
    assert.equal(await balance(bob), 700n);
    assert.equal(await balance(carol), 0n, 'the second transfer was skipped, not reverted');
  });
});
