/**
 * Mesa verification-key upgrade for MyContract on Mina mainnet.
 *
 * Problem
 *   MyContract was compiled with o1js 2.x and deployed in 2025. Since the Mesa hard fork
 *   (mainnet, 2026-09-03) every verification key compiled before Mesa is rejected, so every
 *   proof-authorized call (bump()) fails.
 *
 * Fix (what this script does)
 *   1. Recompiles the unchanged MyContract with o1js 3.1 to get the Mesa verification key.
 *   2. Sends ONE signature-authorized account update on the zkApp account that only replaces its
 *      verification key. The zkApp key signs that update and the fee payer pays the fee.
 *
 *   It deliberately does NOT call deploy(). Redeploying would reset every permission to the
 *   defaults. App state, balance, permissions, zkappUri and delegate are left untouched, and
 *   the state layout is unchanged (one Field, appState[0]), so the existing state stays valid
 *   for the new key.
 *   This works even if setVerificationKey was set to `impossible` or `proof`. While the account's
 *   txnVersion is older than Mesa, the protocol accepts a signature for that change. It cannot
 *   work if `access` is `impossible`; the script checks this before sending.
 *
 * Usage (Node.js >= 22.19.5, o1js 3.1.0)
 *   npm run build
 *   MINA_GRAPHQL_URL=https://<mainnet node>/graphql \
 *   ZKAPP_ADDRESS=B62q... \
 *   ZKAPP_PRIVATE_KEY_FILE=keys/zkapp.json \
 *   FEE_PAYER_PRIVATE_KEY_FILE=keys/fee-payer.json \
 *   node build/upgrade.js [--confirm-with-bump]
 *
 * Environment
 *   MINA_GRAPHQL_URL              required. GraphQL endpoint of a node on the target network.
 *   MINA_NETWORK_ID               'mainnet' (default) or 'devnet' (to rehearse on a devnet copy first).
 *   ZKAPP_PRIVATE_KEY[_FILE]      zkApp private key. Give it inline as base58, or as a file holding the
 *                                 base58 key or a zkapp-cli key JSON ({ "privateKey": ... }).
 *   FEE_PAYER_PRIVATE_KEY[_FILE]  fee payer private key, in the same formats.
 *   ZKAPP_ADDRESS                 optional but recommended. The script aborts if the zkApp key does not match it.
 *   FEE_MINA                      transaction fee in MINA (default 0.1).
 *   O1JS_BACKEND=native           optional. Faster compiling and proving on linux/darwin.
 *
 * --confirm-with-bump
 *   After the upgrade, also send one proof-authorized bump() call to show that the contract
 *   works again. It is off by default because it changes the state (value + 1) and costs a
 *   second fee.
 *
 * Every mainnet transaction is shown in full and needs a typed confirmation before it is sent.
 * Private keys are never printed. Back up the zkApp private key: without it the contract
 * cannot be upgraded again.
 */
import { readFile } from 'node:fs/promises';
import { argv, env, exit, stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { AccountUpdate, Cache, Mina, PrivateKey, PublicKey, fetchAccount } from 'o1js';
import { MyContract } from './MyContract.js';

type Account = ReturnType<typeof Mina.getAccount>;
type AuthRequired = Account['permissions']['access'];
type NetworkId = 'mainnet' | 'devnet';

const NANOMINA_PER_MINA = 1_000_000_000n;
const DEFAULT_FEE_MINA = '0.1';
const MAX_FEE_NANOMINA = 2n * NANOMINA_PER_MINA; // guards against a mistyped fee
// Use a new cache directory: keys cached by o1js 2.x are invalid after Mesa.
const CACHE_DIR = './cache/o1js-3.1.0';
const UPGRADE_MEMO = 'Mesa verification-key upgrade'; // memos are limited to 32 bytes
const CHECK_MEMO = 'Mesa upgrade check';
const INCLUSION_WAIT = { maxAttempts: 90, interval: 20_000 }; // wait up to 30 minutes for inclusion
const FLAG_CONFIRM_WITH_BUMP = '--confirm-with-bump';

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name}.`);
  return value;
}

function parseNetworkId(value: string): NetworkId {
  if (value === 'mainnet' || value === 'devnet') return value;
  throw new Error(`MINA_NETWORK_ID must be 'mainnet' or 'devnet', got '${value}'.`);
}

/** Parses a MINA amount such as "0.1" into nanomina without floating-point rounding. */
function parseMina(text: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,9}))?$/.exec(text.trim());
  if (!match) throw new Error(`FEE_MINA must be a MINA amount with at most 9 decimals, got '${text}'.`);
  return BigInt(match[1]) * NANOMINA_PER_MINA + BigInt((match[2] ?? '').padEnd(9, '0'));
}

function formatMina(nanomina: bigint): string {
  const whole = nanomina / NANOMINA_PER_MINA;
  const fraction = (nanomina % NANOMINA_PER_MINA).toString().padStart(9, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''} MINA`;
}

/**
 * Loads a private key from NAME (base58) or NAME_FILE (a file with the base58 key or a zkapp-cli
 * key JSON). Error messages never include the key material.
 */
async function loadPrivateKey(name: string): Promise<PrivateKey> {
  const inline = env[name]?.trim();
  const file = env[`${name}_FILE`]?.trim();
  if (inline && file) throw new Error(`Set either ${name} or ${name}_FILE, not both.`);

  let base58: string;
  if (inline) {
    base58 = inline;
  } else if (file) {
    const content = (await readFile(file, 'utf8')).trim();
    if (content.startsWith('{')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        throw new Error(`${name}_FILE (${file}) is not valid JSON.`);
      }
      const privateKey = (parsed as { privateKey?: unknown }).privateKey;
      if (typeof privateKey !== 'string') throw new Error(`${name}_FILE (${file}) has no "privateKey" string.`);
      base58 = privateKey.trim();
    } else {
      base58 = content;
    }
  } else {
    throw new Error(`Missing ${name} (base58 private key) or ${name}_FILE (path to a key file).`);
  }

  try {
    return PrivateKey.fromBase58(base58);
  } catch {
    throw new Error(`${name} is not a valid base58 Mina private key.`);
  }
}

function parsePublicKey(name: string, value: string): PublicKey {
  try {
    return PublicKey.fromBase58(value);
  } catch {
    throw new Error(`${name} is not a valid base58 Mina address: '${value}'.`);
  }
}

// ---------------------------------------------------------------------------------------------
// Network and account helpers
// ---------------------------------------------------------------------------------------------

async function fetchOrFail(publicKey: PublicKey, label: string): Promise<Account> {
  const { account, error } = await fetchAccount({ publicKey });
  if (account === undefined) {
    throw new Error(`Could not fetch the ${label} account ${publicKey.toBase58()}: ${JSON.stringify(error)}`);
  }
  return account;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls the node until the account satisfies `done`, because a node can lag right after inclusion. */
async function waitForAccount(
  publicKey: PublicKey,
  label: string,
  done: (account: Account) => boolean,
  attempts = 20,
  intervalMs = 15_000
): Promise<Account> {
  for (let i = 1; ; i++) {
    const account = await fetchOrFail(publicKey, label);
    if (done(account)) return account;
    if (i >= attempts) {
      throw new Error(`The ${label} account did not reach the expected state after ${attempts} checks.`);
    }
    await sleep(intervalMs);
  }
}

async function confirm(question: string, expected: string): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim() === expected;
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Permissions and snapshots
// ---------------------------------------------------------------------------------------------

function authName(auth: AuthRequired): string {
  const constant = auth.constant.toBoolean();
  const necessary = auth.signatureNecessary.toBoolean();
  const sufficient = auth.signatureSufficient.toBoolean();
  if (constant) return sufficient ? 'none' : 'impossible';
  if (necessary) return sufficient ? 'signature' : 'proofAndSignature';
  return sufficient ? 'proofOrSignature' : 'proof';
}

/** Permission name -> auth name (setVerificationKey contributes only its auth, not its txnVersion). */
function describePermissions(account: Account): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(account.permissions)) {
    const auth: AuthRequired = typeof value === 'object' && value !== null && 'auth' in value ? value.auth : value;
    result[key] = authName(auth);
  }
  return result;
}

interface Snapshot {
  appState: string[];
  balance: bigint;
  nonce: bigint;
  vkHash: string | undefined;
  permissions: Record<string, string>;
  setVkTxnVersion: string;
  zkappUri: string | undefined;
  delegate: string | undefined;
}

function snapshot(account: Account): Snapshot {
  return {
    appState: (account.zkapp?.appState ?? []).map((field) => field.toString()),
    balance: account.balance.toBigInt(),
    nonce: account.nonce.toBigint(),
    vkHash: account.zkapp?.verificationKey?.hash.toString(),
    permissions: describePermissions(account),
    setVkTxnVersion: account.permissions.setVerificationKey.txnVersion.toString(),
    zkappUri: account.zkapp?.zkappUri,
    delegate: account.delegate?.toBase58(),
  };
}

function formatPermissions(permissions: Record<string, string>): string {
  return Object.entries(permissions)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
}

/**
 * Checks that the zkApp can take a signed verification-key update. Returns warnings for cases
 * where the transaction relies on the Mesa permission fallback.
 */
function preflight(zkApp: Account, feePayer: Account, fee: bigint): string[] {
  const address = zkApp.publicKey.toBase58();
  if (zkApp.zkapp?.verificationKey === undefined) {
    throw new Error(
      `${address} has no verification key, so it is not a deployed zkApp. ` +
        'This script only upgrades an existing deployment; it never deploys.'
    );
  }
  const { access, incrementNonce, setVerificationKey } = zkApp.permissions;
  if (authName(access) === 'impossible') {
    throw new Error(
      `${address} has access=impossible. The Mesa fallback does not cover this permission, so the account can never be updated again.`
    );
  }
  if (!incrementNonce.signatureSufficient.toBoolean()) {
    throw new Error(
      `${address} has incrementNonce=${authName(incrementNonce)}. A signed account update increments the zkApp ` +
        'nonce, so it would be rejected. Not sending anything.'
    );
  }
  if (feePayer.balance.toBigInt() < fee) {
    throw new Error(
      `The fee payer ${feePayer.publicKey.toBase58()} has ${formatMina(feePayer.balance.toBigInt())}, ` +
        `less than the fee of ${formatMina(fee)}.`
    );
  }

  const warnings: string[] = [];
  const setVk = authName(setVerificationKey.auth);
  if (!setVerificationKey.auth.signatureSufficient.toBoolean()) {
    warnings.push(
      `setVerificationKey=${setVk} (txnVersion ${setVerificationKey.txnVersion.toString()}). The upgrade relies on the ` +
        'Mesa fallback, which accepts a signature while the account has not been updated since the fork.'
    );
  }
  if (authName(access) === 'proof') {
    warnings.push('access=proof. The upgrade relies on the Mesa fallback, which accepts a signature for access.');
  }
  return warnings;
}

// ---------------------------------------------------------------------------------------------
// Optional proof-authorized check (changes state: value + 1)
// ---------------------------------------------------------------------------------------------

async function confirmWithBump(
  networkId: NetworkId,
  zkAppAddress: PublicKey,
  feePayerKey: PrivateKey,
  fee: bigint
): Promise<void> {
  const feePayerAddress = feePayerKey.toPublicKey();
  await fetchOrFail(zkAppAddress, 'zkApp');
  const feePayerAccount = await fetchOrFail(feePayerAddress, 'fee payer');
  if (feePayerAccount.balance.toBigInt() < fee) {
    throw new Error(`The fee payer has too little balance for the bump() check (${formatMina(fee)}).`);
  }

  const zkApp = new MyContract(zkAppAddress);
  const before = zkApp.value.get();

  console.log('\nBuilding and proving bump() with the new verification key...');
  const tx = await Mina.transaction({ sender: feePayerAddress, fee: Number(fee), memo: CHECK_MEMO }, async () => {
    await zkApp.bump();
  });
  await tx.prove();

  console.log('\n=== Review: proof-authorized bump() check ===');
  console.log(`Network:     ${networkId}`);
  console.log(`Fee payer:   ${feePayerAddress.toBase58()} (balance ${formatMina(feePayerAccount.balance.toBigInt())})`);
  console.log(`Fee:         ${formatMina(fee)}. No other MINA moves.`);
  console.log('Account updates (1):');
  console.log(`  #1 zkApp ${zkAppAddress.toBase58()}`);
  console.log('     authorization: proof of MyContract.bump() (o1js 3.1 key)');
  console.log(`     precondition:  value == ${before.toString()}`);
  console.log(`     change:        value ${before.toString()} -> ${before.add(1).toString()}`);
  console.log('Full transaction:');
  console.dir(tx.toPretty(), { depth: null });
  console.log('\nThis CHANGES the on-chain state: value goes up by 1.');

  if (!(await confirm('Type BUMP to send this transaction, anything else skips it: ', 'BUMP'))) {
    console.log('bump() check skipped. Nothing was sent.');
    return;
  }

  const pending = await tx.sign([feePayerKey]).send();
  console.log(`Sent bump() check. Transaction hash: ${pending.hash}`);
  await pending.wait(INCLUSION_WAIT);
  console.log('Included.');

  const expected = before.add(1);
  await waitForAccount(zkAppAddress, 'zkApp', () => new MyContract(zkAppAddress).value.get().equals(expected).toBoolean());
  console.log(`bump() succeeded: value is now ${expected.toString()}. The contract works again.`);
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = argv.slice(2);
  const unknownArgs = args.filter((arg) => arg !== FLAG_CONFIRM_WITH_BUMP);
  if (unknownArgs.length > 0) throw new Error(`Unknown argument(s): ${unknownArgs.join(' ')}`);
  const withBump = args.includes(FLAG_CONFIRM_WITH_BUMP);

  // Configuration and keys
  const graphqlUrl = requireEnv('MINA_GRAPHQL_URL');
  const networkId = parseNetworkId(env.MINA_NETWORK_ID?.trim() || 'mainnet');
  const fee = parseMina(env.FEE_MINA?.trim() || DEFAULT_FEE_MINA);
  if (fee <= 0n || fee > MAX_FEE_NANOMINA) {
    throw new Error(`FEE_MINA must be > 0 and <= ${formatMina(MAX_FEE_NANOMINA)}, got ${formatMina(fee)}.`);
  }

  const zkAppKey = await loadPrivateKey('ZKAPP_PRIVATE_KEY');
  const feePayerKey = await loadPrivateKey('FEE_PAYER_PRIVATE_KEY');
  const zkAppAddress = zkAppKey.toPublicKey();
  const feePayerAddress = feePayerKey.toPublicKey();

  const expectedAddress = env.ZKAPP_ADDRESS?.trim();
  if (expectedAddress) {
    if (!parsePublicKey('ZKAPP_ADDRESS', expectedAddress).equals(zkAppAddress).toBoolean()) {
      throw new Error('ZKAPP_PRIVATE_KEY does not belong to ZKAPP_ADDRESS. Not sending anything.');
    }
  } else {
    console.warn(`ZKAPP_ADDRESS is not set; using the address derived from the zkApp key: ${zkAppAddress.toBase58()}`);
  }
  if (zkAppAddress.equals(feePayerAddress).toBoolean()) {
    throw new Error('The fee payer must be a different account from the zkApp.');
  }

  // networkId must be set explicitly: Mina.Network(url) defaults to devnet, and devnet
  // signatures are invalid on mainnet.
  Mina.setActiveInstance(Mina.Network({ networkId, mina: graphqlUrl }));
  console.log(`Network: ${networkId} via ${graphqlUrl}`);

  // Pre-flight checks, before spending minutes on compilation
  const warnings = preflight(
    await fetchOrFail(zkAppAddress, 'zkApp'),
    await fetchOrFail(feePayerAddress, 'fee payer'),
    fee
  );

  // Compile the unchanged contract with o1js 3.1 to get the Mesa verification key
  console.log('Compiling MyContract with o1js 3.1 (this can take a few minutes)...');
  const { verificationKey } = await MyContract.compile({ cache: Cache.FileSystem(CACHE_DIR) });
  const newVkHash = verificationKey.hash.toString();
  console.log(`New verification key hash: ${newVkHash}`);

  // Fetch again right before building, so nonces and state are current after the compile
  const zkAppAccount = await fetchOrFail(zkAppAddress, 'zkApp');
  const feePayerAccount = await fetchOrFail(feePayerAddress, 'fee payer');
  preflight(zkAppAccount, feePayerAccount, fee);
  const before = snapshot(zkAppAccount);

  if (before.vkHash === newVkHash) {
    console.log('The on-chain verification key already matches o1js 3.1. No upgrade needed; nothing was sent.');
    if (withBump) await confirmWithBump(networkId, zkAppAddress, feePayerKey, fee);
    return;
  }

  // Build the upgrade: one signed account update that only sets the verification key
  const tx = await Mina.transaction(
    { sender: feePayerAddress, fee: Number(fee), memo: UPGRADE_MEMO },
    async () => {
      const update = AccountUpdate.createSigned(zkAppAddress);
      update.account.verificationKey.set(verificationKey);
    }
  );
  if (tx.transaction.accountUpdates.length !== 1) {
    throw new Error(`Expected exactly 1 account update, got ${tx.transaction.accountUpdates.length}. Not sending.`);
  }

  // Show everything and wait for an explicit confirmation
  console.log('\n=== Review: Mesa verification-key upgrade ===');
  console.log(`Network:        ${networkId} via ${graphqlUrl}`);
  console.log(
    `Fee payer:      ${feePayerAddress.toBase58()} (balance ${formatMina(feePayerAccount.balance.toBigInt())}, ` +
      `nonce ${feePayerAccount.nonce.toString()})`
  );
  console.log(`Fee:            ${formatMina(fee)}, paid by the fee payer. No other MINA moves.`);
  console.log('Account updates (1):');
  console.log(`  #1 zkApp ${zkAppAddress.toBase58()}`);
  console.log('     authorization:   signature of the zkApp key');
  console.log(`     change:          verificationKey ${before.vkHash} -> ${newVkHash}`);
  console.log(`     zkApp nonce:     ${before.nonce} -> ${before.nonce + 1n}`);
  console.log('     balance change:  0');
  console.log('     not touched:     app state, permissions, zkappUri, delegate');
  console.log(`Current value (appState[0], kept): ${before.appState[0] ?? '(none)'}`);
  console.log(`zkApp balance (kept): ${formatMina(before.balance)}`);
  console.log(`zkApp permissions (kept): ${formatPermissions(before.permissions)}`);
  console.log(`setVerificationKey txnVersion: ${before.setVkTxnVersion}`);
  for (const warning of warnings) console.warn(`Note: ${warning}`);
  console.log('Full transaction:');
  console.dir(tx.toPretty(), { depth: null });

  if (!(await confirm(`\nType UPGRADE to sign and send this transaction to ${networkId}: `, 'UPGRADE'))) {
    console.log('Aborted. Nothing was sent.');
    return;
  }

  // Sign with the fee payer and the zkApp key, then send. No proof is needed.
  const pending = await tx.sign([feePayerKey, zkAppKey]).send();
  console.log(`Sent. Transaction hash: ${pending.hash}`);
  console.log('Waiting for inclusion (Mesa slots are 90 s)...');
  await pending.wait(INCLUSION_WAIT);
  console.log('Included.');

  // Verify: new key on chain, and state, balance and permissions unchanged
  const after = snapshot(
    await waitForAccount(zkAppAddress, 'zkApp', (account) => account.zkapp?.verificationKey?.hash.toString() === newVkHash)
  );
  console.log(`On-chain verification key hash: ${after.vkHash}`);
  console.log(`setVerificationKey txnVersion: ${before.setVkTxnVersion} -> ${after.setVkTxnVersion}`);

  const problems: string[] = [];
  const stateKept =
    before.appState.length === after.appState.length && before.appState.every((value, i) => value === after.appState[i]);
  if (!stateKept) problems.push(`app state changed: ${JSON.stringify(before.appState)} -> ${JSON.stringify(after.appState)}`);
  if (before.balance !== after.balance) {
    problems.push(`balance changed: ${formatMina(before.balance)} -> ${formatMina(after.balance)}`);
  }
  for (const [key, value] of Object.entries(before.permissions)) {
    if (after.permissions[key] !== value) problems.push(`permission ${key} changed: ${value} -> ${after.permissions[key]}`);
  }
  if (before.zkappUri !== after.zkappUri) problems.push(`zkappUri changed: ${before.zkappUri} -> ${after.zkappUri}`);
  if (before.delegate !== after.delegate) problems.push(`delegate changed: ${before.delegate} -> ${after.delegate}`);
  if (problems.length > 0) {
    throw new Error(`The verification key was updated, but something else changed unexpectedly:\n  ${problems.join('\n  ')}`);
  }
  console.log(`Upgrade complete. State kept: value = ${after.appState[0] ?? '(none)'}; balance and permissions unchanged.`);

  if (withBump) {
    await confirmWithBump(networkId, zkAppAddress, feePayerKey, fee);
  } else {
    console.log(`To confirm with a proof-authorized call (sets value + 1), run again with ${FLAG_CONFIRM_WITH_BUMP}.`);
  }
  console.log('Reminder: keep a backup of the zkApp private key. Future upgrades need it.');
}

// o1js keeps worker threads alive after compiling, so exit explicitly.
main().then(
  () => exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    exit(1);
  }
);
