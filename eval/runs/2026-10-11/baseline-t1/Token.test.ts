// node:test and node:assert ship with Node. package.json does not list
// @types/node, so the @ts-ignore comments keep `tsc` working with or without it.
// @ts-ignore
import { before, beforeEach, describe, it } from 'node:test';
// @ts-ignore
import assert from 'node:assert/strict';
import {
  AccountUpdate,
  Bool,
  Field,
  Int64,
  Mina,
  Permissions,
  PrivateKey,
  PublicKey,
  UInt64,
} from 'o1js';
import { Token } from './Token.js';

// Proofs are mocked for speed; the "circuits" test below still checks that
// every method is provable. Set to true for a full run with real proofs
// (compiles the contract first, which takes minutes).
const proofsEnabled = false;
const SYMBOL = 'TKN';

async function sendTx(sender: PublicKey, signers: PrivateKey[], body: () => Promise<void>) {
  const tx = await Mina.transaction(sender, body);
  await tx.prove();
  await tx.sign(signers).send();
}

/** Fresh local chain with the token deployed, so every test is independent. */
async function setup() {
  const local = await Mina.LocalBlockchain({ proofsEnabled });
  Mina.setActiveInstance(local);
  const [deployer, admin, alice, bob, mallory] = local.testAccounts;

  const tokenKey = PrivateKey.random();
  const tokenAddress = tokenKey.toPublicKey();
  const token = new Token(tokenAddress);
  const tokenId = token.deriveTokenId();

  await sendTx(deployer, [deployer.key, tokenKey], async () => {
    AccountUpdate.fundNewAccount(deployer);
    await token.deploy({ admin, symbol: SYMBOL });
  });

  return { deployer, admin, alice, bob, mallory, tokenKey, tokenAddress, token, tokenId };
}

type Env = Awaited<ReturnType<typeof setup>>;

async function mintAsAdmin({ admin, token, tokenId }: Env, to: PublicKey, amount: bigint) {
  // Paying for an account that is not created would fail with Invalid_fee_excess.
  const isNewAccount = !Mina.hasAccount(to, tokenId);
  await sendTx(admin, [admin.key], async () => {
    if (isNewAccount) AccountUpdate.fundNewAccount(admin);
    await token.mint(to, UInt64.from(amount));
  });
}

function balanceOf(address: PublicKey, tokenId: Field): bigint {
  return Mina.hasAccount(address, tokenId) ? Mina.getBalance(address, tokenId).toBigInt() : 0n;
}

type Auth = { constant: Bool; signatureNecessary: Bool; signatureSufficient: Bool };

function describeAuth(auth: Auth): string {
  return [auth.constant, auth.signatureNecessary, auth.signatureSufficient]
    .map((flag) => flag.toBoolean())
    .join('/');
}

describe('Token', () => {
  let env: Env;

  before(async () => {
    if (proofsEnabled) await Token.compile();
  });

  beforeEach(async () => {
    env = await setup();
  });

  it('deploys with the chosen admin and locked-down permissions', async () => {
    assert.equal(env.token.admin.get().toBase58(), env.admin.toBase58());

    const account = Mina.getAccount(env.tokenAddress);
    assert.equal(account.tokenSymbol, SYMBOL);
    assert.equal(describeAuth(account.permissions.access), describeAuth(Permissions.proof()));
    assert.equal(
      describeAuth(account.permissions.setPermissions),
      describeAuth(Permissions.impossible())
    );
    assert.equal(
      describeAuth(account.permissions.setVerificationKey.auth),
      describeAuth(Permissions.impossible())
    );
  });

  it('lets the admin mint', async () => {
    await mintAsAdmin(env, env.alice, 1_000n);
    assert.equal(balanceOf(env.alice, env.tokenId), 1_000n);

    // Second mint to an existing token account (no creation fee).
    await mintAsAdmin(env, env.alice, 500n);
    assert.equal(balanceOf(env.alice, env.tokenId), 1_500n);
  });

  it('rejects a mint that is not signed by the admin', async () => {
    const { mallory, token, tokenId } = env;

    // Same transaction shape as the admin mint, but signed only by mallory.
    await assert.rejects(() =>
      sendTx(mallory, [mallory.key], async () => {
        AccountUpdate.fundNewAccount(mallory);
        await token.mint(mallory, UInt64.from(1_000n));
      })
    );
    assert.equal(balanceOf(mallory, tokenId), 0n);
  });

  it('lets a holder transfer tokens to another holder', async () => {
    const { alice, bob, token, tokenId } = env;
    await mintAsAdmin(env, alice, 1_000n);
    await mintAsAdmin(env, bob, 100n);

    await sendTx(alice, [alice.key], async () => {
      await token.transfer(alice, bob, UInt64.from(400n));
    });

    assert.equal(balanceOf(alice, tokenId), 600n);
    assert.equal(balanceOf(bob, tokenId), 500n);
  });

  it('rejects holder-approved updates that would create tokens', async () => {
    const { mallory, token, tokenId } = env;

    await assert.rejects(() =>
      sendTx(mallory, [mallory.key], async () => {
        AccountUpdate.fundNewAccount(mallory);
        const credit = AccountUpdate.create(mallory, tokenId);
        credit.balanceChange = Int64.from(1_000n);
        await token.approveAccountUpdate(credit);
      })
    );
    assert.equal(balanceOf(mallory, tokenId), 0n);
  });

  it('rejects a credit that is applied before its matching debit', async () => {
    const { alice, bob, token, tokenId } = env;
    await mintAsAdmin(env, alice, 1_000n);
    await mintAsAdmin(env, bob, 100n);

    // Balanced overall, but bob would hold unfunded tokens until alice's debit.
    await assert.rejects(() =>
      sendTx(alice, [alice.key], async () => {
        const credit = AccountUpdate.create(bob, tokenId);
        credit.balanceChange = Int64.from(400n);
        const debit = AccountUpdate.createSigned(alice, tokenId);
        debit.balanceChange = Int64.from(400n).neg();
        await token.approveAccountUpdates([credit, debit]);
      })
    );
    assert.equal(balanceOf(alice, tokenId), 1_000n);
    assert.equal(balanceOf(bob, tokenId), 100n);
  });

  it('rejects token updates authorized by the zkApp key instead of a proof', async () => {
    const { deployer, mallory, tokenKey, tokenAddress, tokenId } = env;

    await assert.rejects(() =>
      sendTx(deployer, [deployer.key, tokenKey], async () => {
        AccountUpdate.fundNewAccount(deployer);
        const owner = AccountUpdate.createSigned(tokenAddress);
        const credit = AccountUpdate.create(mallory, tokenId);
        credit.balanceChange = Int64.from(1_000n);
        owner.approve(credit);
      })
    );
    assert.equal(balanceOf(mallory, tokenId), 0n);
  });
});

describe('Token circuits', () => {
  it('compiles every method to a provable circuit within the row limit', async () => {
    const methods = await Token.analyzeMethods();
    assert.ok(methods.mint, 'mint should be analyzed');
    assert.ok(methods.approveBase, 'approveBase should be analyzed');
    assert.ok(methods.mint.rows < 2 ** 16, 'mint exceeds the circuit size limit');
    assert.ok(methods.approveBase.rows < 2 ** 16, 'approveBase exceeds the circuit size limit');
  });
});
