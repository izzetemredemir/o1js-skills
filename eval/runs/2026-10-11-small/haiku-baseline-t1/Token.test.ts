import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AccountUpdate, Mina, PrivateKey, UInt64 } from 'o1js';
import { CustomToken } from './Token.js';

const FEE = 0.1e9;

describe('CustomToken', () => {
  let local: Awaited<ReturnType<typeof Mina.LocalBlockchain>>;
  let deployer: { key: PrivateKey; publicKey: ReturnType<PrivateKey['toPublicKey']> };
  let admin: typeof deployer;
  let alice: typeof deployer;
  let bob: typeof deployer;
  let mallory: typeof deployer;
  let zkAppKey: PrivateKey;
  let zkApp: CustomToken;
  let tokenId: ReturnType<CustomToken['deriveTokenId']>;

  before(async () => {
    local = await Mina.LocalBlockchain({ proofsEnabled: true });
    Mina.setActiveInstance(local);
    [deployer, admin, alice, bob, mallory] = local.testAccounts;

    zkAppKey = PrivateKey.random();
    zkApp = new CustomToken(zkAppKey.toPublicKey());
    tokenId = zkApp.deriveTokenId();

    await CustomToken.compile();
  });

  it('deploys and initializes the admin in one transaction', async () => {
    const tx = await Mina.transaction({ sender: deployer.publicKey, fee: FEE }, async () => {
      AccountUpdate.fundNewAccount(deployer.publicKey);
      await zkApp.deploy();
      await zkApp.initialize(admin.publicKey);
    });
    await tx.prove();
    await tx.sign([deployer.key, zkAppKey]).send();

    assert.equal(zkApp.admin.get().toBase58(), admin.publicKey.toBase58());
    assert.equal(zkApp.totalSupply.get().toBigInt(), 0n);
    assert.equal(zkApp.initialized.get().toBoolean(), true);
  });

  it('rejects a second initialize', async () => {
    await assert.rejects(async () => {
      const tx = await Mina.transaction({ sender: mallory.publicKey, fee: FEE }, async () => {
        await zkApp.initialize(mallory.publicKey);
      });
      await tx.prove();
      await tx.sign([mallory.key]).send();
    });
    assert.equal(zkApp.admin.get().toBase58(), admin.publicKey.toBase58());
  });

  it('lets the admin mint to a holder', async () => {
    const tx = await Mina.transaction({ sender: admin.publicKey, fee: FEE }, async () => {
      AccountUpdate.fundNewAccount(admin.publicKey);
      await zkApp.mint(alice.publicKey, UInt64.from(1000));
    });
    await tx.prove();
    await tx.sign([admin.key]).send();

    assert.equal(Mina.getBalance(alice.publicKey, tokenId).toBigInt(), 1000n);
    assert.equal(zkApp.totalSupply.get().toBigInt(), 1000n);
  });

  it('rejects a mint by a non-admin', async () => {
    await assert.rejects(async () => {
      const tx = await Mina.transaction({ sender: mallory.publicKey, fee: FEE }, async () => {
        AccountUpdate.fundNewAccount(mallory.publicKey);
        await zkApp.mint(mallory.publicKey, UInt64.from(1_000_000));
      });
      await tx.prove();
      await tx.sign([mallory.key]).send();
    });

    assert.equal(zkApp.totalSupply.get().toBigInt(), 1000n);
    assert.equal(Mina.hasAccount(mallory.publicKey, tokenId), false);
  });

  it('transfers tokens between holders', async () => {
    const tx = await Mina.transaction({ sender: alice.publicKey, fee: FEE }, async () => {
      AccountUpdate.fundNewAccount(alice.publicKey);
      await zkApp.transfer(alice.publicKey, bob.publicKey, UInt64.from(250));
    });
    await tx.prove();
    await tx.sign([alice.key]).send();

    assert.equal(Mina.getBalance(alice.publicKey, tokenId).toBigInt(), 750n);
    assert.equal(Mina.getBalance(bob.publicKey, tokenId).toBigInt(), 250n);
    assert.equal(zkApp.totalSupply.get().toBigInt(), 1000n);
  });

  it('rejects a transfer that is not signed by the sender', async () => {
    await assert.rejects(async () => {
      const tx = await Mina.transaction({ sender: mallory.publicKey, fee: FEE }, async () => {
        AccountUpdate.fundNewAccount(mallory.publicKey);
        await zkApp.transfer(alice.publicKey, mallory.publicKey, UInt64.from(100));
      });
      await tx.prove();
      await tx.sign([mallory.key]).send();
    });

    assert.equal(Mina.getBalance(alice.publicKey, tokenId).toBigInt(), 750n);
  });
});
