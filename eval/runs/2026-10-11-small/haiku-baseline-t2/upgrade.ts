/**
 * Upgrades the verification key of the deployed MyContract zkApp on Mina mainnet
 * so that it works again after the Mesa hard fork.
 *
 * Only the verification key is changed. The on-chain app state, permissions and
 * balance are left untouched. The script never calls init() or deploy(), so the
 * state is not reset.
 *
 * Required environment variables:
 *   ZKAPP_PRIVATE_KEY        base58 private key of the deployed zkApp account
 *   FEE_PAYER_PRIVATE_KEY    base58 private key of the funded fee payer
 *
 * Optional:
 *   MINA_GRAPHQL_ENDPOINT    default: https://api.minascan.io/node/mainnet/v1/graphql
 *   MINA_ARCHIVE_ENDPOINT    default: https://api.minascan.io/archive/mainnet/v1/graphql
 *   CONFIRM_MAINNET_UPGRADE  must be exactly "yes" to actually send the transaction.
 *                            Without it the script only compiles, checks and prints the plan.
 */
import { AccountUpdate, Mina, PrivateKey, fetchAccount } from 'o1js';
import { MyContract } from './MyContract.js';

const DEFAULT_GRAPHQL_ENDPOINT = 'https://api.minascan.io/node/mainnet/v1/graphql';
const DEFAULT_ARCHIVE_ENDPOINT = 'https://api.minascan.io/archive/mainnet/v1/graphql';
const FEE_MINA = 0.1;
const FEE_NANOMINA = BigInt(Math.round(FEE_MINA * 1e9));

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable ${name}`);
  }
  return value;
}

function appStateToStrings(fields: readonly { toString(): string }[] | undefined): string[] | undefined {
  return fields?.map((f) => f.toString());
}

async function main() {
  const zkappKey = PrivateKey.fromBase58(requireEnv('ZKAPP_PRIVATE_KEY'));
  const feePayerKey = PrivateKey.fromBase58(requireEnv('FEE_PAYER_PRIVATE_KEY'));
  const zkappAddress = zkappKey.toPublicKey();
  const feePayerAddress = feePayerKey.toPublicKey();

  Mina.setActiveInstance(
    Mina.Network({
      mina: process.env.MINA_GRAPHQL_ENDPOINT ?? DEFAULT_GRAPHQL_ENDPOINT,
      archive: process.env.MINA_ARCHIVE_ENDPOINT ?? DEFAULT_ARCHIVE_ENDPOINT,
    })
  );

  // 1. Read the current on-chain state of the zkApp and of the fee payer.
  const zkappFetch = await fetchAccount({ publicKey: zkappAddress });
  if (!zkappFetch.account) {
    throw new Error(`zkApp account ${zkappAddress.toBase58()} not found on the configured network`);
  }
  const zkappBefore = zkappFetch.account;

  const feeFetch = await fetchAccount({ publicKey: feePayerAddress });
  if (!feeFetch.account) {
    throw new Error(`Fee payer ${feePayerAddress.toBase58()} not found on the configured network`);
  }
  if (feeFetch.account.balance.toBigInt() < FEE_NANOMINA) {
    throw new Error(`Fee payer balance is below the ${FEE_MINA} MINA fee`);
  }

  const stateBefore = appStateToStrings(zkappBefore.zkapp?.appState);
  const vkHashBefore = zkappBefore.zkapp?.verificationKey?.hash.toString();
  console.log('zkApp:', zkappAddress.toBase58());
  console.log('Current app state:', stateBefore);
  console.log('Current verification key hash:', vkHashBefore);

  // 2. Make sure the account is still allowed to change its verification key.
  const vkPermission = zkappBefore.permissions.setVerificationKey;
  console.log('setVerificationKey permission:', vkPermission);
  if (
    vkPermission.constant.toBoolean() &&
    vkPermission.signatureNecessary.toBoolean() &&
    !vkPermission.signatureSufficient.toBoolean()
  ) {
    throw new Error(
      'setVerificationKey is set to "impossible" on this account. The verification key cannot be changed.'
    );
  }

  // 3. Compile the current source with o1js 3.x to get the new verification key.
  console.log('Compiling MyContract with the installed o1js version...');
  const { verificationKey } = await MyContract.compile();
  console.log('New verification key hash:', verificationKey.hash.toString());

  if (vkHashBefore === verificationKey.hash.toString()) {
    console.log('The on-chain verification key already matches the new build. Nothing to do.');
    return;
  }

  // 4. Build a transaction that only sets the verification key.
  //    createSigned authorises the update with the zkApp key, so no proof is needed.
  //    No state fields are written, so the on-chain state is kept.
  const tx = await Mina.transaction({ sender: feePayerAddress, fee: FEE_MINA }, async () => {
    const update = AccountUpdate.createSigned(zkappAddress);
    update.account.verificationKey.set(verificationKey);
  });

  if (process.env.CONFIRM_MAINNET_UPGRADE !== 'yes') {
    console.log(
      'Dry run: transaction built but not sent. Set CONFIRM_MAINNET_UPGRADE=yes to broadcast it to mainnet.'
    );
    return;
  }

  // 5. Sign with the fee payer and the zkApp key, then send and wait for inclusion.
  tx.sign([feePayerKey, zkappKey]);
  const pending = await tx.send();
  console.log('Transaction hash:', pending.hash);
  await pending.wait();
  console.log('Transaction included.');

  // 6. Verify the result: new verification key, unchanged app state.
  const zkappAfter = (await fetchAccount({ publicKey: zkappAddress })).account;
  if (!zkappAfter) {
    throw new Error('Could not re-fetch the zkApp account after the upgrade');
  }
  const vkHashAfter = zkappAfter.zkapp?.verificationKey?.hash.toString();
  const stateAfter = appStateToStrings(zkappAfter.zkapp?.appState);

  if (vkHashAfter !== verificationKey.hash.toString()) {
    throw new Error(`Verification key on chain (${vkHashAfter}) does not match the new build`);
  }
  if (JSON.stringify(stateAfter) !== JSON.stringify(stateBefore)) {
    throw new Error(`App state changed during upgrade: before ${stateBefore}, after ${stateAfter}`);
  }
  console.log('Upgrade verified. App state unchanged:', stateAfter);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
