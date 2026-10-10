import {
  AccountUpdateForest,
  Bool,
  Permissions,
  PublicKey,
  State,
  TokenContract,
  UInt64,
  method,
  state,
} from 'o1js';

/**
 * Custom Mina token.
 *
 * - The admin is chosen once, at deploy time, through `initialize`.
 *   Deploy and initialize must run in the same transaction so nobody can
 *   front-run the admin choice.
 * - Only the admin can mint. Minting is the only way to create tokens.
 * - Holders transfer tokens with `transfer`, which requires the sender's signature.
 * - Permissions are locked after deploy: the owner account cannot be re-permissioned.
 */
export class CustomToken extends TokenContract {
  @state(PublicKey) admin = State<PublicKey>();
  @state(UInt64) totalSupply = State<UInt64>();
  @state(Bool) initialized = State<Bool>();

  init() {
    super.init();
    this.account.permissions.set({
      ...Permissions.default(),
      editState: Permissions.proof(),
      send: Permissions.proof(),
      setPermissions: Permissions.impossible(),
    });
  }

  /** One-shot setup of the admin. Must be called in the deploy transaction. */
  @method async initialize(admin: PublicKey) {
    this.initialized.getAndRequireEquals().assertFalse();
    this.admin.set(admin);
    this.totalSupply.set(UInt64.zero);
    this.initialized.set(Bool(true));
  }

  /** Only the admin can create new tokens. */
  @method async mint(recipient: PublicKey, amount: UInt64) {
    this.initialized.getAndRequireEquals().assertTrue();
    const admin = this.admin.getAndRequireEquals();
    this.sender.getAndRequireSignature().assertEquals(admin);

    const supply = this.totalSupply.getAndRequireEquals();
    // UInt64.add asserts that the result does not overflow.
    this.totalSupply.set(supply.add(amount));

    this.internal.mint({ address: recipient, amount });
  }

  /** Holder-to-holder transfer. The sender must sign. */
  @method async transfer(from: PublicKey, to: PublicKey, amount: UInt64) {
    const senderUpdate = this.internal.send({ from, to, amount });
    senderUpdate.requireSignature();
  }

  /** Keeps every non-mint account update balance-neutral. */
  approveBase(forest: AccountUpdateForest): void {
    this.checkZeroBalanceChange(forest);
  }
}
