import {
  AccountUpdateForest,
  DeployArgs,
  Permissions,
  PublicKey,
  State,
  TokenContract,
  UInt64,
  method,
  state,
} from 'o1js';

/**
 * Custom fungible token.
 *
 * - The admin (chosen at deploy time) is the only account that can mint.
 * - Holders can transfer tokens; every token movement must balance out (no creation or destruction).
 * - The token contract's `access` permission is `proof()`, so no one can touch token accounts
 *   without going through this contract's methods (no bypass via the contract key or by creating
 *   the token owner's account update directly).
 */
export class Token extends TokenContract {
  @state(PublicKey) admin = State<PublicKey>();

  async deploy(args: DeployArgs & { admin: PublicKey }) {
    // Requires a new account. TokenContract.deploy() sets access to proofOrSignature, which we override below.
    await super.deploy(args);
    this.admin.set(args.admin);

    // Spreading Permissions.default() resets `access` to none, so `access` is set explicitly afterwards.
    // proof(), not proofOrSignature(): with the latter, whoever holds the token contract's key can bypass approveBase.
    // setVerificationKey and setPermissions are locked so the rules cannot be silently replaced after deployment.
    this.account.permissions.set({
      ...Permissions.default(),
      access: Permissions.proof(),
      setVerificationKey: Permissions.VerificationKey.impossibleDuringCurrentVersion(),
      setPermissions: Permissions.impossible(),
    });
  }

  @method async mint(to: PublicKey, amount: UInt64) {
    const admin = this.admin.getAndRequireEquals();
    // getAndRequireSignature() forces the sender to sign; getUnconstrained() would let anyone claim to be admin.
    this.sender.getAndRequireSignature().assertEquals(admin);
    this.internal.mint({ address: to, amount });
  }

  // Invoked by TokenContract.transfer() and every other token operation. Only balance-neutral movements pass.
  @method async approveBase(forest: AccountUpdateForest) {
    this.checkZeroBalanceChange(forest);
  }
}
