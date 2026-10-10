# Custom tokens

## How tokens work on Mina

- **Token identity:**
  - Every account is identified by `(publicKey, tokenId)`.
  - MINA has the default token ID.
  - A custom token's ID is derived from its token contract (the "token owner"): `TokenId.derive(ownerAddress)`, or `this.deriveTokenId()` inside the contract.
- **The protocol rule:** any account update that changes a balance of a custom token must be a child of an account update of the token owner. The owner's update must itself be authorized according to the owner's `access` permission.
- **What `TokenContract` provides:** `approveBase(forest)` is where the token's rules live, and `checkZeroBalanceChange` enforces that transfers neither create nor destroy tokens.

Tested example: [SimpleToken.ts](../examples/token/SimpleToken.ts), [SimpleToken.test.ts](../examples/token/SimpleToken.test.ts).

## A minimal token

```ts
export class SimpleToken extends TokenContract {
  @state(PublicKey) admin = State<PublicKey>();

  async deploy(args: DeployArgs & { admin: PublicKey }) {
    await super.deploy(args);        // requires a new account; upgrades access from none to proofOrSignature
    this.admin.set(args.admin);
    this.account.permissions.set({
      ...Permissions.default(),
      access: Permissions.proof(),   // must be set again: spreading the defaults resets it to none
      setVerificationKey: Permissions.VerificationKey.impossibleDuringCurrentVersion(),
      setPermissions: Permissions.impossible(),
    });
  }

  @method async mint(to: PublicKey, amount: UInt64) {
    const admin = this.admin.getAndRequireEquals();
    this.sender.getAndRequireSignature().assertEquals(admin);
    this.internal.mint({ address: to, amount });
  }

  @method async approveBase(forest: AccountUpdateForest) {
    this.checkZeroBalanceChange(forest);
  }
}
```

Using it:

```ts
// mint to a new holder: creating the holder's token account costs 1 MINA
await Mina.transaction(admin, async () => {
  AccountUpdate.fundNewAccount(admin);
  await token.mint(alice, UInt64.from(100));
});

// transfer: `transfer` is inherited from TokenContract and goes through approveBase
await Mina.transaction(alice, async () => {
  AccountUpdate.fundNewAccount(alice);   // bob's token account is new
  await token.transfer(alice, bob, UInt64.from(30));
});

Mina.getBalance(alice, token.deriveTokenId());  // read a token balance
```

Deploy and the first mint must be separate transactions: `mint` reads the admin from on-chain state, which doesn't exist until the deploy transaction is applied.

## The `access` permission is the token's security boundary

Three outcomes, all reproduced by the tests **[T]**:

| `access` on the token contract | Who can mint without going through `approveBase` |
|---|---|
| `none` (what you get by spreading `Permissions.default()` after `super.deploy()`) | **Anyone.** They create the owner's account update themselves (`LeakyToken` test) |
| `proofOrSignature()` (what `TokenContract.deploy()` sets on its own) | **Whoever holds the token contract's private key** (`KeyHolderToken` test; Veridise V-MIN-VUL-006) |
| `proof()` | No one. Every token operation must go through a contract method; bypass attempts fail with `Update_not_permitted_access` |

The official tutorial 08 (`BasicTokenContract`, `WhitelistedTokenContract` in MinaProtocol/docs2) spreads `Permissions.default()` after `super.deploy()` and therefore ends up with `access: none`. Don't copy it.

## approveBase rules

- **`approveBase` must be a `@method`.** `transfer`, `approveAccountUpdate` and `approveAccountUpdates` all route through it.
- **Size limit:** `forEachUpdate` and `checkZeroBalanceChange` iterate at most `TokenContract.MAX_ACCOUNT_UPDATES` (9) updates; more fails.
- **Per-update checks:** the default `checkZeroBalanceChange` only checks the final sum, so it accepts two things a production token should reject **[T: [StrictToken.test.ts](../examples/token/StrictToken.test.ts)]**:
  - crediting tokens before the matching debit (a flash mint, V-MIN-VUL-002);
  - a holder setting their token account's `receive` to `impossible`, after which transfers to them fail.

  The fungible-token standard's `internalApproveBase` blocks both. Ported to o1js 3.1 ([StrictToken.ts](../examples/token/StrictToken.ts)):

```ts
@method async approveBase(forest: AccountUpdateForest) {
  let total = Int64.zero;
  this.forEachUpdate(forest, (update, usesToken) => {
    assertKeepsPermissionsOpen(update);
    total = Provable.if(usesToken, total.add(update.balanceChange), total);
    total.isPositive().assertFalse('tokens credited before they were debited');
  });
  total.assertEquals(Int64.zero);
}

function assertKeepsPermissionsOpen(update: AccountUpdate) {
  const permissions = update.update.permissions;
  const { access, receive } = permissions.value;
  const staysOpen = Provable.equal(Types.AuthRequired, access, Permissions.none()).and(
    Provable.equal(Types.AuthRequired, receive, Permissions.none())
  );
  assert(staysOpen.or(permissions.isSome.not()), 'token accounts must keep access and receive at none');
}
```
- **Never approve arbitrary caller-supplied account updates** in other methods, and never take "is this a mint?" flags from the caller.

## Other token APIs

```ts
this.internal.mint({ address, amount });
this.internal.burn({ address, amount });          // requires the holder's signature
this.internal.send({ from, to, amount });         // requires the sender's signature
this.account.tokenSymbol.set('MYT');              // in init/deploy
```

- **Balance changes on token accounts are `UInt64`/`Int64`.** Decimals are an app-level convention; store them in state if clients need them.
- **Contracts can own token accounts too.** Instantiate the contract with the token ID: `new MyContract(address, tokenId)`. Since 3.1, nested `@method` calls are bound to that token ID.
