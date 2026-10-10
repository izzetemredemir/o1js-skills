/**
 * Upgrade the on-chain verification key of an already deployed MyContract
 * (compiled with o1js 2.x) to one compiled with the installed o1js 3.x (Mesa).
 *
 * It only replaces the verification key. It does NOT call deploy(), so the
 * contract's app state and permissions are left untouched and init() is not run.
 *
 * Env vars:
 *   MINA_GRAPHQL_ENDPOINT  mainnet GraphQL endpoint (required, a Mesa-compatible node)
 *   MINA_ARCHIVE_ENDPOINT  archive endpoint (optional)
 *   ZKAPP_PRIVATE_KEY      zkApp account private key (base58)
 *   FEE_PAYER_PRIVATE_KEY  funded fee payer private key (base58)
 *   FEE_MINA               fee in MINA (optional, default 0.1)
 *   DRY_RUN=1              build, prove and sign but do not send
 */
import { AccountUpdate, Field, Mina, PrivateKey, UInt64, fetchAccount } from 'o1js';
import { MyContract } from './MyContract.js';

function env(name: string, required = true): string {
  const v = process.env[name];
  if (!v && required) throw new Error(`Missing env var ${name}`);
  return v ?? '';
}

async function main() {
  const endpoint = env('MINA_GRAPHQL_ENDPOINT');
  const archive = env('MINA_ARCHIVE_ENDPOINT', false);
  Mina.setActiveInstance(
    Mina.Network({
      networkId: 'mainnet',
      mina: endpoint,
      ...(archive ? { archive } : {}),
    })
  );

  const zkAppKey = PrivateKey.fromBase58(env('ZKAPP_PRIVATE_KEY'));
  const feePayerKey = PrivateKey.fromBase58(env('FEE_PAYER_PRIVATE_KEY'));
  const zkAppAddress = zkAppKey.toPublicKey();
  const feePayer = feePayerKey.toPublicKey();
  const fee = UInt64.from(Math.round(Number(env('FEE_MINA', false) || '0.1') * 1e9));

  console.log('zkApp:', zkAppAddress.toBase58());

  const zkApp = new MyContract(zkAppAddress);

  // Current on-chain account
  const before = await fetchAccount({ publicKey: zkAppAddress });
  if (before.error || !before.account?.zkapp) {
    throw new Error(`zkApp account not found or not a zkApp: ${before.error?.statusText}`);
  }
  await fetchAccount({ publicKey: feePayer });

  const stateBefore: Field[] = before.account.zkapp.appState;
  const oldHash = before.account.zkapp.verificationKey?.hash.toString();
  console.log('on-chain vk hash:', oldHash);
  console.log('app state before:', stateBefore.map((f) => f.toString()).join(','));

  // The vk can be changed with a signature only if the permission allows it.
  const perm = before.account.permissions.setVerificationKey.auth;
  if (!perm.signatureSufficient.toBoolean()) {
    throw new Error(
      'setVerificationKey is not signature-authorized on this account; a signature-only upgrade is impossible.'
    );
  }

  // Compile with the installed o1js 3.x
  console.log('compiling...');
  const { verificationKey } = await MyContract.compile();
  console.log('new vk hash:', verificationKey.hash.toString());

  if (oldHash === verificationKey.hash.toString()) {
    console.log('Verification key already up to date, nothing to do.');
    return;
  }

  // Only update the verification key; the zkApp key signs the account update.
  // The transaction is built with the current (Mesa) transaction version by o1js 3.x.
  const tx = await Mina.transaction({ sender: feePayer, fee }, async () => {
    const update = AccountUpdate.createSigned(zkAppAddress);
    update.account.verificationKey.set(verificationKey);
  });
  await tx.prove();
  tx.sign([feePayerKey, zkAppKey]);

  if (process.env.DRY_RUN === '1') {
    console.log('DRY_RUN set, not sending. Transaction:\n', tx.toPretty());
    return;
  }

  const sent = await tx.send();
  console.log('sent tx:', sent.hash);
  await sent.wait();
  console.log('tx included.');

  // Verify: vk replaced, state untouched
  const after = await fetchAccount({ publicKey: zkAppAddress });
  const zk = after.account?.zkapp;
  if (!zk) throw new Error('Could not re-fetch zkApp account');
  const newHash = zk.verificationKey?.hash.toString();
  const stateAfter = zk.appState;
  console.log('on-chain vk hash now:', newHash);
  if (newHash !== verificationKey.hash.toString()) {
    throw new Error('Verification key on chain does not match the new one');
  }
  if (stateAfter.some((f, i) => !f.equals(stateBefore[i]).toBoolean())) {
    throw new Error('App state changed unexpectedly!');
  }
  console.log('Upgrade successful, app state preserved:', stateAfter.map((f) => f.toString()).join(','));
  void zkApp;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
