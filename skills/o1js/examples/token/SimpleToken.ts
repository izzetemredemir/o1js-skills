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

/** Minimal custom token: the admin mints, holders transfer, and every token movement must balance out. */
export class SimpleToken extends TokenContract {
  @state(PublicKey) admin = State<PublicKey>();

  async deploy(args: DeployArgs & { admin: PublicKey }) {
    // TokenContract.deploy() upgrades `access` from none to proofOrSignature and requires the account to be new.
    await super.deploy(args);
    this.admin.set(args.admin);
    // Spreading Permissions.default() would reset `access` to none, so set it explicitly. Use proof(), not
    // proofOrSignature(): with the latter, whoever holds the token contract key can sign around approveBase.
    this.account.permissions.set({
      ...Permissions.default(),
      access: Permissions.proof(),
      setVerificationKey: Permissions.VerificationKey.impossibleDuringCurrentVersion(),
      setPermissions: Permissions.impossible(),
    });
  }

  @method async mint(to: PublicKey, amount: UInt64) {
    const admin = this.admin.getAndRequireEquals();
    // getAndRequireSignature() makes the sender sign; getUnconstrained() would let anyone claim to be admin.
    this.sender.getAndRequireSignature().assertEquals(admin);
    this.internal.mint({ address: to, amount });
  }

  @method async approveBase(forest: AccountUpdateForest) {
    this.checkZeroBalanceChange(forest);
  }
}

/** Anti-example: keeps TokenContract's default `access: proofOrSignature`, so the contract key can mint. */
export class KeyHolderToken extends TokenContract {
  @method async approveBase(forest: AccountUpdateForest) {
    this.checkZeroBalanceChange(forest);
  }
}

/** Anti-example: same token, but deploy() resets every permission to the defaults, including `access: none`. */
export class LeakyToken extends TokenContract {
  async deploy(args?: DeployArgs) {
    await super.deploy(args);
    this.account.permissions.set({ ...Permissions.default() });
  }

  @method async approveBase(forest: AccountUpdateForest) {
    this.checkZeroBalanceChange(forest);
  }
}
