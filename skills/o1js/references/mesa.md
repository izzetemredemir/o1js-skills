# Mesa hard fork

Mesa went live on devnet on 2026-08-19 and on mainnet on 2026-09-03. It needs o1js ≥ 3.0, and you should use 3.1.0 or later.

## What changed for zkApps

| | Before (Berkeley) | Mesa |
|---|---|---|
| On-chain state per account | 8 field elements | 32 field elements **[T]** |
| Account updates per transaction | Weighted cost formula (`TransactionCost.*`) | `np + n2 + n1 ≤ 16` segments: proof updates, pairs of non-proof updates, single non-proof updates. The fee payer counts as one **[T]** |
| Events and actions per transaction | 100 field elements each, at most 16 per event or action | 1024 field elements of events and, separately, 1024 of actions; no per-event cap |
| Slot time | 180 s | 90 s. Durations written as slot counts now pass twice as fast |
| Verification keys | Compiled with o1js 2.x | All changed. Old keys and old proofs are rejected |
| Transaction signing | mina-signer 3 | mina-signer 4 signs the Mesa format by default (`era: 'berkeley'` for the old one) |
| Hard forks | Manual | Automated hard-fork support |

**[T]** = tested in [../examples/limits/Limits.test.ts](../examples/limits/Limits.test.ts). The limit error contains "The maximum number of segments per transaction is 16".

Sources: [o1js CHANGELOG 3.0.0](https://github.com/o1-labs/o1js/blob/main/CHANGELOG.md), [Mesa docs](https://docs.minaprotocol.com/network-upgrades/mesa), [MIP 30 (segments)](https://github.com/MinaProtocol/MIPs/pull/30).

LocalBlockchain still simulates 3-minute slots, and `Mina.getNetworkConstants().slotTime` returns that 180 000 ms default until o1js has fetched the network's genesis constants. On Mesa networks a slot is 90 000 ms.

## Upgrading a contract deployed before Mesa

Every pre-Mesa zkApp stays frozen for proof-authorized transactions until its verification key is updated.

**Do not redeploy.** Calling `deploy()` again resets all permissions to the defaults **[T: [Upgradable.test.ts](../examples/upgrade/Upgradable.test.ts)]**.

Instead, compile with o1js 3.1 and send one signed account update, signed by the fee payer and the zkApp key:

```ts
const { verificationKey } = await MyContract.compile(); // o1js 3.1
await fetchAccount({ publicKey: zkAppAddress });
await fetchAccount({ publicKey: sender });

const tx = await Mina.transaction({ sender, fee: 100_000_000 }, async () => {
  const update = AccountUpdate.createSigned(zkAppAddress);
  update.account.verificationKey.set(verificationKey);
});
const pending = await tx.sign([senderKey, zkAppKey]).send();
await pending.wait();
```

What the upgrade preserves and requires:
- **State and balance are preserved,** and there is no deadline.
- **You can change the code at the same time,** as long as the new contract keeps a compatible state layout.
- **Afterwards, confirm with a normal proof-authorized method call.**

### Why this works even for locked contracts

While an account's `txnVersion` is older than the current protocol version, the protocol temporarily relaxes some permissions:
- `setVerificationKey: impossible` and `setVerificationKey: proof` fall back to `signature`.
- `access: proof` falls back to `signature`.
- `setPermissions: impossible` does not block the upgrade.
- **`access: impossible` has no fallback.** That account stays locked forever.

The upgrade bumps `txnVersion`, and the original permissions apply again.

**Without the zkApp private key the contract cannot be upgraded.** Tell users to back up that key.

Source: [docs.o1labs.org — Upgrading zkApps to Mesa](https://docs.o1labs.org/o1js/zkapps/upgrade-mesa).

### o1js 3.1.0 changes keys again

3.1.0 fixed account-update vulnerabilities:
- an update with `PublicKey.empty()` could be pruned;
- nested `@method` calls could have their token ID substituted;
- the callee's update was not fully checked.

The CHANGELOG says verification keys change, without restricting it to particular contracts; the fixes touch code that runs for any method with child account updates. Treat every contract as affected. If you deployed with 3.0.x:
1. Recompile with 3.1.
2. Compare `verificationKey.hash` with the on-chain key.
3. Update the key if they differ.

The post-fork fallback no longer helps here. If you already upgraded under 3.0, the update needs whatever `setVerificationKey` permission the account has now. A contract set to `impossibleDuringCurrentVersion()` cannot take this fix until the next hard fork.

## Network configuration

```ts
Mina.setActiveInstance(
  Mina.Network({
    networkId: 'mainnet', // the default is 'devnet': wrong signatures on mainnet
    mina: 'https://<mainnet graphql endpoint>',
    archive: 'https://<mainnet archive endpoint>',
  })
);
```

Valid `networkId` values are `'mainnet'`, `'devnet'` and `{ custom: '...' }`. `'testnet'` is a deprecated alias for devnet. There is no `'mesa'` id.

**Check archive freshness before trusting `fetchEvents` or `Mina.fetchActions`.** After the fork, at least one popular public mainnet archive endpoint stopped indexing at block 548,187 (2026-09-03) while its node endpoint kept syncing. Compare the archive's latest block with the node's best chain height.

## Known documentation bugs

As of 2026-10-11, these official sources contain code that is wrong for o1js 3.1. Each was checked against the docs source (o1-labs/o1js-documentation-site, MinaProtocol/docs2):

- **docs.o1labs.org, Mesa upgrade page, "Full upgrade script":** it calls `Mina.Network(GRAPHQL_ENDPOINT)` with a mainnet endpoint but no `networkId: 'mainnet'`. That defaults to devnet, so the signatures are wrong for mainnet.
- **docs.o1labs.org, deployment snippet** (`snippets/zkapps/deployment/deployment.ts`):
  - It calls `contract.deploy({ verificationKey })` without `await`.
  - Its devnet examples use the deprecated `networkId: 'testnet'`.
- **docs.o1labs.org, ZkProgram snippet** (`snippets/zk-program/zk-program.ts`): it calls `SimpleZkProgram.verify(proof)` without `await` and ignores the result. `verify` returns a `Promise<boolean>`, so nothing is actually checked.
- **docs.minaprotocol.com, Mesa pages:**
  - `mesa-trail.mdx`, `requirements.mdx` and `upgrade-steps/examples.mdx` pin `o1js@3.0.0-mesa.rc2`; use `^3.1.0`.
  - `requirements.mdx` says every zkApp must be redeployed. A signed verification-key update is enough, and a redeploy resets permissions.
  - `upgrade-steps/examples.mdx` shows `zkapp deploy --network mainnet`, but `zk deploy` takes a deploy alias, not a `--network` flag.
- **docs.minaprotocol.com, tutorial 08 (custom tokens):** `BasicTokenContract` and `WhitelistedTokenContract` spread `Permissions.default()` after `super.deploy()`. That resets `access` to `none`, so anyone can mint by creating the token owner's account update directly. Our `LeakyToken` test reproduces exactly this ([tokens.md](tokens.md)).
- **zkapp-cli 0.23.0:** the project template pins `"o1js": "^2.*"`.
