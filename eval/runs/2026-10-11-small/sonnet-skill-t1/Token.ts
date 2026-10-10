import {
  AccountUpdateForest,
  DeployArgs,
  Int64,
  Permissions,
  Provable,
  PublicKey,
  State,
  TokenContract,
  UInt64,
  method,
  state,
} from 'o1js';

/**
 * Custom token: the admin (fixed at deploy time) can mint, holders can transfer, and nobody else can
 * create tokens.
 *
 * Security notes:
 * - `access` is `proof()`, so every account update of the token owner must come from a method of this
 *   contract. Neither a random user (`none`) nor the contract key holder (`proofOrSignature`) can mint
 *   around `approveBase`.
 * - Verification key and permissions are locked (`impossibleDuringCurrentVersion` / `impossible`), so
 *   the admin cannot change the rules. The admin is immutable; losing its key means no more minting.
 *   Back up the token contract key and the admin key.
 * - `approveBase` checks the running balance after every update (no flash mints) and forbids token
 *   account updates from changing permissions (a holder could otherwise block transfers).
 */
export class Token extends TokenContract {
  @state(PublicKey) admin = State<PublicKey>();

  async deploy(args: DeployArgs & { admin: PublicKey }) {
    // Requires a new account; sets access to proofOrSignature, which is tightened below.
    await super.deploy(args);
    this.admin.set(args.admin);
    this.account.permissions.set({
      ...Permissions.default(),
      access: Permissions.proof(), // must be set again: spreading the defaults resets it to none
      editState: Permissions.proof(),
      send: Permissions.proof(),
      setVerificationKey: Permissions.VerificationKey.impossibleDuringCurrentVersion(),
      setPermissions: Permissions.impossible(),
      setZkappUri: Permissions.impossible(),
      setTokenSymbol: Permissions.impossible(),
      setTiming: Permissions.impossible(),
      incrementNonce: Permissions.impossible(),
      setVotingFor: Permissions.impossible(),
    });
  }

  @method async mint(to: PublicKey, amount: UInt64) {
    const admin = this.admin.getAndRequireEquals();
    // The sender must sign; getUnconstrained() would let the prover claim to be the admin.
    this.sender.getAndRequireSignature().assertEquals(admin);
    this.internal.mint({ address: to, amount });
  }

  @method async approveBase(forest: AccountUpdateForest) {
    let total = Int64.zero;
    this.forEachUpdate(forest, (update, usesToken) => {
      // Token accounts must not change their own permissions (e.g. to block receiving).
      usesToken.not().or(update.body.update.permissions.isSome.not()).assertTrue(
        'Token account updates must not change permissions'
      );

      // Updates of other tokens do not count.
      total = total.add(Provable.if(usesToken, Int64, update.balanceChange, Int64.zero));

      // The running total may never become positive: no flash mints within a transaction.
      const positive = total.isPositive().and(total.magnitude.equals(UInt64.zero).not());
      positive.assertFalse('Token balance changes must not create tokens');
    });
    // Tokens are neither created nor destroyed by transfers.
    total.assertEquals(Int64.zero);
  }
}
