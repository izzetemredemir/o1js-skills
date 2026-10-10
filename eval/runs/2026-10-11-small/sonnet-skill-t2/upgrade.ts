/**
 * Mesa upgrade for a zkApp deployed with o1js 2.x: replace the on-chain
 * verification key with one compiled by o1js 3.1.0, using a single signed
 * account update. On-chain state and balance are preserved. We deliberately
 * do NOT call deploy() (it would reset permissions).
 *
 * Required env vars:
 *   MINA_GRAPHQL_URL   mainnet node GraphQL endpoint
 *   MINA_ARCHIVE_URL   mainnet archive endpoint (optional, not used for this tx)
 *   ZKAPP_PRIVATE_KEY  base58 private key of the zkApp account
 *   FEE_PAYER_KEY      base58 private key of the funded fee payer
 *   ZKAPP_ADDRESS      (optional) expected zkApp address, sanity check
 *   FEE_NANOMINA       (optional) fee in nanomina, default 100000000 (0.1 MINA)
 *   CONFIRM_MAINNET    must be "yes" to actually send; otherwise dry run
 */
import { AccountUpdate, Mina, PrivateKey, fetchAccount } from 'o1js';
import { MyContract } from './MyContract.js';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

async function main() {
  const graphql = requireEnv('MINA_GRAPHQL_URL');
  const archive = process.env.MINA_ARCHIVE_URL;
  const zkAppKey = PrivateKey.fromBase58(requireEnv('ZKAPP_PRIVATE_KEY'));
  const feePayerKey = PrivateKey.fromBase58(requireEnv('FEE_PAYER_KEY'));
  const fee = BigInt(process.env.FEE_NANOMINA ?? '100000000');

  const zkAppAddress = zkAppKey.toPublicKey();
  const feePayer = feePayerKey.toPublicKey();

  const expected = process.env.ZKAPP_ADDRESS;
  if (expected && expected !== zkAppAddress.toBase58()) {
    throw new Error(
      `ZKAPP_PRIVATE_KEY does not match ZKAPP_ADDRESS (${zkAppAddress.toBase58()} vs ${expected})`
    );
  }

  // networkId must be 'mainnet': the default is devnet and signatures would be invalid.
  Mina.setActiveInstance(
    Mina.Network({
      networkId: 'mainnet',
      mina: graphql,
      ...(archive ? { archive } : {}),
    })
  );

  console.log('Compiling MyContract with o1js 3.1.0 ...');
  const { verificationKey } = await MyContract.compile();

  const zkAppRes = await fetchAccount({ publicKey: zkAppAddress });
  if (zkAppRes.error) throw new Error(`Cannot fetch zkApp account: ${zkAppRes.error.statusText}`);
  const feeRes = await fetchAccount({ publicKey: feePayer });
  if (feeRes.error) throw new Error(`Cannot fetch fee payer account: ${feeRes.error.statusText}`);

  const onChain = Mina.getAccount(zkAppAddress);
  const onChainHash = onChain.zkapp?.verificationKey?.hash;
  if (!onChain.zkapp || !onChainHash) {
    throw new Error('Account has no zkApp verification key; this is not a deployed zkApp.');
  }
  if (onChainHash.equals(verificationKey.hash).toBoolean()) {
    console.log('On-chain verification key already matches the o1js 3.1.0 key. Nothing to do.');
    return;
  }

  console.log('Network:            mainnet');
  console.log('zkApp:              ' + zkAppAddress.toBase58());
  console.log('Fee payer:          ' + feePayer.toBase58());
  console.log('Fee (nanomina):     ' + fee);
  console.log('Balance moved:      none');
  console.log('Account updates:    1 signed update setting verificationKey on the zkApp');
  console.log('Old key hash:       ' + onChainHash.toString());
  console.log('New key hash:       ' + verificationKey.hash.toString());

  if (process.env.CONFIRM_MAINNET !== 'yes') {
    console.log('Dry run only. Set CONFIRM_MAINNET=yes to send this transaction.');
    return;
  }

  const tx = await Mina.transaction({ sender: feePayer, fee }, async () => {
    const update = AccountUpdate.createSigned(zkAppAddress);
    update.account.verificationKey.set(verificationKey);
  });
  // Signature-authorized only: no proving needed.
  const pending = await tx.sign([feePayerKey, zkAppKey]).send();
  console.log('Sent: ' + pending.hash);
  await pending.wait();
  console.log('Included in a block. Verification key updated.');

  await fetchAccount({ publicKey: zkAppAddress });
  const after = Mina.getAccount(zkAppAddress).zkapp?.verificationKey?.hash;
  if (!after || !after.equals(verificationKey.hash).toBoolean()) {
    throw new Error('Post-check failed: on-chain key hash does not match the new key.');
  }
  console.log('Verified on-chain key hash matches. Confirm with a normal bump() call.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
