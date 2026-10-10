import {
  AccountUpdate,
  AccountUpdateForest,
  DeployArgs,
  Int64,
  Permissions,
  Provable,
  PublicKey,
  State,
  TokenContract,
  Types,
  UInt64,
  assert,
  method,
  state,
} from 'o1js';

/**
 * SimpleToken plus the per-update checks of the fungible-token standard (`internalApproveBase`):
 * - the running total may never go positive, so tokens can't be credited before they are debited (flash mint);
 * - holders can't change their token account's `access`/`receive`, which could block transfers to them.
 */
export class StrictToken extends TokenContract {
  @state(PublicKey) admin = State<PublicKey>();

  async deploy(args: DeployArgs & { admin: PublicKey }) {
    await super.deploy(args);
    this.admin.set(args.admin);
    this.account.permissions.set({
      ...Permissions.default(),
      access: Permissions.proof(),
      setVerificationKey: Permissions.VerificationKey.impossibleDuringCurrentVersion(),
      setPermissions: Permissions.impossible(),
    });
  }

  @method async mint(to: PublicKey, amount: UInt64) {
    this.sender.getAndRequireSignature().assertEquals(this.admin.getAndRequireEquals());
    this.internal.mint({ address: to, amount });
  }

  @method async approveBase(forest: AccountUpdateForest) {
    let total = Int64.zero;
    this.forEachUpdate(forest, (update, usesToken) => {
      assertKeepsPermissionsOpen(update);
      total = Provable.if(usesToken, total.add(update.balanceChange), total);
      total.isPositive().assertFalse('tokens credited before they were debited');
    });
    total.assertEquals(Int64.zero);
  }
}

function assertKeepsPermissionsOpen(update: AccountUpdate) {
  const permissions = update.update.permissions;
  const { access, receive } = permissions.value;
  const staysOpen = Provable.equal(Types.AuthRequired, access, Permissions.none()).and(
    Provable.equal(Types.AuthRequired, receive, Permissions.none())
  );
  assert(staysOpen.or(permissions.isSome.not()), 'token accounts must keep access and receive at none');
}

/** Builds the two halves of a transfer by hand, in a chosen order. */
export function transferHalves(tokenId: Types.TokenId, from: PublicKey, to: PublicKey, amount: number) {
  const debit = AccountUpdate.default(from, tokenId);
  debit.balanceChange = Int64.from(amount).neg();
  debit.requireSignature();
  const credit = AccountUpdate.default(to, tokenId);
  credit.balanceChange = Int64.from(amount);
  return { debit, credit };
}
