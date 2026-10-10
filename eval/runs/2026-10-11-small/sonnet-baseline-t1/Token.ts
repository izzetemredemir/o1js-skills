import {
  AccountUpdate,
  AccountUpdateForest,
  DeployArgs,
  Permissions,
  PublicKey,
  State,
  Struct,
  TokenContract,
  UInt64,
  method,
  state,
} from 'o1js';

export class MintEvent extends Struct({
  recipient: PublicKey,
  amount: UInt64,
}) {}

/**
 * Custom token contract.
 *
 * - The admin public key is fixed at deploy time and can never be changed.
 * - Only the admin (by signature) can mint, and only via `mint()`.
 * - Holders move tokens with `transfer()` (inherited from TokenContract) or by
 *   passing account updates through `approveBase`, which enforces that the
 *   token supply is not changed by anything except this contract's own `mint`.
 *
 * The contract is locked down at deploy time: its verification key and its
 * permissions can not be changed afterwards (no upgrade path / no admin
 * backdoor). Test thoroughly before mainnet; a bug cannot be patched.
 */
export class Token extends TokenContract {
  @state(PublicKey) admin = State<PublicKey>();

  events = { Mint: MintEvent };

  async deploy(args: DeployArgs & { admin: PublicKey }) {
    await super.deploy(args);

    this.admin.set(args.admin);

    this.account.tokenSymbol.set('TKN');
    this.account.permissions.set({
      ...Permissions.default(),
      // state can only change through proven methods
      editState: Permissions.proof(),
      // contract logic is immutable (and survives the hard fork window safely)
      setVerificationKey: Permissions.VerificationKey.impossibleDuringCurrentVersion(),
      setPermissions: Permissions.impossible(),
      setTokenSymbol: Permissions.impossible(),
      // the contract account itself never needs to be spent from by a signature
      send: Permissions.proof(),
      incrementNonce: Permissions.impossible(),
    });
  }

  /**
   * Called for every batch of account updates that use this token.
   * Transfers are balance-neutral; anything that would create or destroy
   * tokens is rejected here. Minting happens only inside `mint()`, where the
   * token owner (this contract) authorizes it.
   */
  @method
  async approveBase(forest: AccountUpdateForest) {
    this.checkZeroBalanceChange(forest);
  }

  /** Mint `amount` new tokens to `to`. Requires the admin's signature. */
  @method
  async mint(to: PublicKey, amount: UInt64) {
    const admin = this.admin.getAndRequireEquals();
    // forces the admin's signature on the transaction
    AccountUpdate.createSigned(admin);

    this.internal.mint({ address: to, amount });
    this.emitEvent('Mint', new MintEvent({ recipient: to, amount }));
  }
}
