/**
 * Post-Mesa upgrade of MyContract on Mina mainnet.
 *
 * Why transactions fail: MyContract was compiled with o1js 2.x, so the
 * verification key stored on-chain belongs to the pre-Mesa zkApp circuit.
 * Mesa changed the protocol's zkApp/account-update layout, so proofs from the
 * old circuit (or a newer o1js) no longer verify against that key.
 *
 * Fix: recompile the unchanged contract with o1js 3.1.0 and replace ONLY the
 * account's verification key with a signature from the zkApp key. We do not
 * call `deploy()` or `init()`, and we leave app state, permissions, zkappUri
 * and tokenSymbol alone, so the on-chain state stays as it is. Even if the
 * account's `setVerificationKey` permission was `impossible`/`proof`, the
 * protocol treats a permission from an older transaction version as
 * `signature` after a hard fork. That rule is what makes this upgrade possible.
 *
 * Usage:
 *   npm run build
 *   ZKAPP_PRIVATE_KEY=EK... FEE_PAYER_PRIVATE_KEY=EK... \
 *     node build/upgrade.js [--dry-run]
 *
 * Optional environment variables:
 *   ZKAPP_ADDRESS     expected zkApp address (B62...), checked against the key
 *   FEE_MINA          transaction fee in MINA (default 0.1)
 *   MINA_GRAPHQL_URL  mainnet node GraphQL endpoint
 *   MINA_ARCHIVE_URL  mainnet archive GraphQL endpoint
 */
import {
  AccountUpdate,
  Mina,
  PrivateKey,
  PublicKey,
  UInt64,
  fetchAccount,
} from 'o1js';
import { MyContract } from './MyContract.js';

const DEFAULT_GRAPHQL_URL = 'https://api.minascan.io/node/mainnet/v1/graphql';
const DEFAULT_ARCHIVE_URL = 'https://api.minascan.io/archive/mainnet/v1/graphql';
const DEFAULT_FEE_MINA = '0.1';
const MAX_FEE_MINA = 10n; // sanity bound against typos in FEE_MINA
const NANOMINA_PER_MINA = 1_000_000_000n;

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function requireEnv(name: string): string {
  const value = readEnv(name);
  if (value === undefined) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function parsePrivateKey(name: string): PrivateKey {
  const raw = requireEnv(name);
  try {
    return PrivateKey.fromBase58(raw);
  } catch {
    // Never echo the raw value: it is a secret.
    throw new Error(`${name} is not a valid base58 Mina private key`);
  }
}

/** Parses a decimal MINA amount ("0.1") into nanomina without float rounding. */
function minaToNanomina(amount: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,9}))?$/.exec(amount);
  if (!match) throw new Error(`Invalid MINA amount: "${amount}"`);
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? '').padEnd(9, '0'));
  return whole * NANOMINA_PER_MINA + fraction;
}

function formatMina(nanomina: bigint): string {
  const whole = nanomina / NANOMINA_PER_MINA;
  const fraction = (nanomina % NANOMINA_PER_MINA).toString().padStart(9, '0');
  return `${whole}.${fraction.replace(/0+$/, '') || '0'}`;
}

async function fetchExistingAccount(publicKey: PublicKey, label: string) {
  const { account, error } = await fetchAccount({ publicKey });
  if (error !== undefined || account === undefined) {
    throw new Error(
      `Could not fetch ${label} account ${publicKey.toBase58()}: ${JSON.stringify(error)}`
    );
  }
  return account;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  // Keys and configuration
  const zkAppKey = parsePrivateKey('ZKAPP_PRIVATE_KEY');
  const feePayerKey = parsePrivateKey('FEE_PAYER_PRIVATE_KEY');
  const zkAppAddress = zkAppKey.toPublicKey();
  const feePayerAddress = feePayerKey.toPublicKey();

  const expectedAddress = readEnv('ZKAPP_ADDRESS');
  if (
    expectedAddress !== undefined &&
    !PublicKey.fromBase58(expectedAddress).equals(zkAppAddress).toBoolean()
  ) {
    throw new Error(
      `ZKAPP_PRIVATE_KEY belongs to ${zkAppAddress.toBase58()}, not ZKAPP_ADDRESS=${expectedAddress}`
    );
  }

  const feeNanomina = minaToNanomina(readEnv('FEE_MINA') ?? DEFAULT_FEE_MINA);
  if (feeNanomina === 0n || feeNanomina > MAX_FEE_MINA * NANOMINA_PER_MINA) {
    throw new Error(`FEE_MINA must be > 0 and <= ${MAX_FEE_MINA} MINA`);
  }
  const fee = UInt64.from(feeNanomina);

  // networkId 'mainnet' matters: signatures for 'testnet' are invalid on mainnet.
  Mina.setActiveInstance(
    Mina.Network({
      networkId: 'mainnet',
      mina: readEnv('MINA_GRAPHQL_URL') ?? DEFAULT_GRAPHQL_URL,
      archive: readEnv('MINA_ARCHIVE_URL') ?? DEFAULT_ARCHIVE_URL,
    })
  );

  console.log(`zkApp:     ${zkAppAddress.toBase58()}`);
  console.log(`Fee payer: ${feePayerAddress.toBase58()}`);
  console.log(`Fee:       ${formatMina(feeNanomina)} MINA`);
  console.log(`Mode:      ${dryRun ? 'DRY RUN (nothing will be sent)' : 'LIVE (mainnet)'}`);

  // 1. Inspect the deployed account before changing anything
  const zkAppBefore = await fetchExistingAccount(zkAppAddress, 'zkApp');
  const oldVk = zkAppBefore.zkapp?.verificationKey;
  if (zkAppBefore.zkapp === undefined || oldVk === undefined) {
    throw new Error(
      `${zkAppAddress.toBase58()} has no verification key on-chain; it is not a deployed zkApp. ` +
        'Refusing to continue (a fresh deploy would run init() and reset state).'
    );
  }
  const stateBefore = zkAppBefore.zkapp.appState.map((f) => f.toString());
  console.log(`On-chain vk hash:   ${oldVk.hash.toString()}`);
  console.log(`On-chain app state: [${stateBefore.join(', ')}]`);

  const permissions = zkAppBefore.permissions;
  const vkPermission = permissions.setVerificationKey;
  if (!vkPermission.auth.signatureSufficient.toBoolean()) {
    console.warn(
      `setVerificationKey is not 'signature' (txnVersion ${vkPermission.txnVersion.toString()}). ` +
        'Relying on the hard-fork fallback, which treats a permission from an older ' +
        'transaction version as signature. If it is still current, the network will reject the update.'
    );
  }
  // createSigned() authorizes with a signature and increments the account nonce.
  if (!permissions.access.signatureSufficient.toBoolean()) {
    throw new Error("The zkApp's 'access' permission does not accept a signature.");
  }
  if (!permissions.incrementNonce.signatureSufficient.toBoolean()) {
    throw new Error("The zkApp's 'incrementNonce' permission does not accept a signature.");
  }

  const feePayerBefore = await fetchExistingAccount(feePayerAddress, 'fee payer');
  if (feePayerBefore.balance.lessThan(fee).toBoolean()) {
    throw new Error(
      `Fee payer balance ${formatMina(feePayerBefore.balance.toBigInt())} MINA is below the fee`
    );
  }

  // 2. Compile the unchanged contract with o1js 3.1.0 (Mesa)
  console.log('Compiling MyContract with o1js 3.1.0 (this can take a few minutes)...');
  const { verificationKey } = await MyContract.compile();
  console.log(`New vk hash:        ${verificationKey.hash.toString()}`);

  if (oldVk.hash.equals(verificationKey.hash).toBoolean()) {
    console.log('The on-chain verification key already matches. Nothing to do.');
    return;
  }

  // Refresh nonces after the long compile so the transaction uses current values.
  await fetchExistingAccount(zkAppAddress, 'zkApp');
  await fetchExistingAccount(feePayerAddress, 'fee payer');

  // 3. Build a signed update that changes only the verification key
  const tx = await Mina.transaction(
    { sender: feePayerAddress, fee, memo: 'MyContract Mesa vk upgrade' },
    async () => {
      const update = AccountUpdate.createSigned(zkAppAddress);
      update.account.verificationKey.set(verificationKey);
    }
  );
  await tx.prove(); // no proof-authorized updates; kept for uniformity
  tx.sign([feePayerKey, zkAppKey]);

  if (dryRun) {
    console.log(JSON.stringify(tx.toPretty(), null, 2));
    console.log('Dry run complete. Re-run without --dry-run to send.');
    return;
  }

  const pending = await tx.send();
  console.log(`Sent: ${pending.hash}`);
  console.log(`Explorer: https://minascan.io/mainnet/tx/${pending.hash}`);
  console.log('Waiting for inclusion...');
  await pending.wait({ maxAttempts: 90, interval: 20_000 });

  // 4. Check the result on-chain
  const zkAppAfter = await fetchExistingAccount(zkAppAddress, 'zkApp');
  const vkAfter = zkAppAfter.zkapp?.verificationKey;
  if (vkAfter === undefined || !vkAfter.hash.equals(verificationKey.hash).toBoolean()) {
    throw new Error(
      `Transaction included but the on-chain vk hash is ${vkAfter?.hash.toString() ?? 'missing'}`
    );
  }
  const stateAfter = (zkAppAfter.zkapp?.appState ?? []).map((f) => f.toString());
  const stateKept =
    stateAfter.length === stateBefore.length &&
    stateAfter.every((value, i) => value === stateBefore[i]);
  if (!stateKept) {
    throw new Error(
      `App state changed unexpectedly: before [${stateBefore.join(', ')}], after [${stateAfter.join(', ')}]`
    );
  }

  console.log('Upgrade complete: the new verification key is on-chain and app state is unchanged.');
  console.log(
    'Clients that call bump() must now compile MyContract with o1js 3.1.0 before proving.'
  );
}

// o1js keeps worker threads alive, so exit explicitly.
main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
);
