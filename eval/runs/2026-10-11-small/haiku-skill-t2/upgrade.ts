// Upgrades the verification key of the MyContract zkApp deployed on Mina mainnet
// before the Mesa hard fork, so its transactions are accepted again.
//
// Why this and not deploy(): calling deploy() again resets every permission to
// the defaults. A signed verification-key update changes only the key and keeps
// the on-chain state and balance.
//
// Usage (secrets come from the environment, never from source or chat):
//   MINA_GRAPHQL_URL=...  MINA_ARCHIVE_URL=...  \
//   ZKAPP_PRIVATE_KEY=...  FEE_PAYER_PRIVATE_KEY=...  \
//   [TX_FEE=100000000] node build/upgrade.js
//
// The script prints the plan and waits for the operator to type UPGRADE.

import { createInterface } from 'node:readline/promises';
import { AccountUpdate, Mina, PrivateKey, fetchAccount } from 'o1js';
import { MyContract } from './MyContract.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

async function main() {
  const graphqlUrl = requireEnv('MINA_GRAPHQL_URL');
  const archiveUrl = requireEnv('MINA_ARCHIVE_URL');
  const zkAppKey = PrivateKey.fromBase58(requireEnv('ZKAPP_PRIVATE_KEY'));
  const feePayerKey = PrivateKey.fromBase58(requireEnv('FEE_PAYER_PRIVATE_KEY'));
  const fee = Number(process.env.TX_FEE ?? '100000000'); // 0.1 MINA by default

  // networkId must be explicit: the default is devnet, and mainnet signatures would be wrong.
  Mina.setActiveInstance(
    Mina.Network({ networkId: 'mainnet', mina: graphqlUrl, archive: archiveUrl })
  );

  const zkAppAddress = zkAppKey.toPublicKey();
  const feePayer = feePayerKey.toPublicKey();

  const zkAppAccount = await fetchAccount({ publicKey: zkAppAddress });
  if (!zkAppAccount.account) {
    throw new Error(`zkApp account ${zkAppAddress.toBase58()} not found on mainnet`);
  }
  await fetchAccount({ publicKey: feePayer });

  // Compile the current source with o1js 3.x. The compiled key is what gets written on-chain.
  const { verificationKey } = await MyContract.compile();

  const onChainHash = zkAppAccount.account.zkapp?.verificationKey?.hash;
  if (onChainHash !== undefined && onChainHash.toString() === verificationKey.hash.toString()) {
    console.log('On-chain verification key already matches the o1js 3.x build. Nothing to do.');
    return;
  }

  console.log('--- Upgrade plan (mainnet) ---');
  console.log(`Network:          mainnet (${graphqlUrl})`);
  console.log(`zkApp address:    ${zkAppAddress.toBase58()}`);
  console.log(`Fee payer:        ${feePayer.toBase58()}`);
  console.log(`Fee (nanomina):   ${fee}`);
  console.log(`Account updates:  1 signed update (verificationKey only; state and balance untouched)`);
  console.log(`setVerificationKey permission: ${String(zkAppAccount.account.permissions?.setVerificationKey)}`);
  console.log(`New verification key hash: ${verificationKey.hash.toString()}`);
  console.log(`Old verification key hash: ${onChainHash?.toString() ?? '(unknown)'}`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Type UPGRADE to send this transaction to mainnet: ');
  rl.close();
  if (answer.trim() !== 'UPGRADE') {
    console.log('Aborted. Nothing was sent.');
    return;
  }

  const tx = await Mina.transaction({ sender: feePayer, fee }, async () => {
    AccountUpdate.createSigned(zkAppAddress).account.verificationKey.set(verificationKey);
  });

  // Signed by the fee payer and by the zkApp key (which controls the upgrade).
  const pending = await tx.sign([feePayerKey, zkAppKey]).send();
  console.log('Submitted. Waiting for inclusion...');
  await pending.wait();

  // Confirm the new key is live.
  const after = await fetchAccount({ publicKey: zkAppAddress, force: true });
  const liveHash = after.account?.zkapp?.verificationKey?.hash?.toString();
  if (liveHash === verificationKey.hash.toString()) {
    console.log('Verification key updated on mainnet. State and balance were preserved.');
    console.log('Next: run one normal proof-authorized method call to confirm the contract works.');
  } else {
    console.log('Transaction included, but the on-chain key does not match yet. Re-check the account before retrying.');
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
