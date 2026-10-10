import {
  AccountUpdate,
  AccountUpdateForest,
  type DeployArgs,
  Permissions,
  Provable,
  PublicKey,
  State,
  Struct,
  TokenContract,
  UInt64,
  method,
  state,
} from 'o1js';

/**
 * Custom token with a single minting authority.
 *
 * Security model
 * - Only `admin` (fixed at deploy time, never changeable) can create tokens,
 *   through `mint`, which requires the admin's signature.
 * - Holders move tokens with the inherited `transfer`, `approveAccountUpdate`
 *   and `approveAccountUpdates`, which all go through `approveBase`. It only
 *   approves balance changes that sum to zero, and a credit can never run
 *   ahead of the debits that fund it (no transient "flash minting").
 * - The contract account is locked at deploy time:
 *   - `access: proof()`: every account update on this account, and therefore
 *     every token operation, must carry a proof of one of the methods below.
 *     A signature from the zkApp private key can neither approve token
 *     updates nor do anything else on this account.
 *   - `setPermissions: impossible()` and
 *     `setVerificationKey: impossibleDuringCurrentVersion()`: the code and
 *     permissions can never be changed. (After a hard fork that bumps the
 *     transaction version the protocol relaxes the VK permission to
 *     `signature`, but `access: proof()` still rejects signature-only updates.)
 *   The contract is therefore immutable once deployed: review it before going
 *   to mainnet.
 *
 * Mainnet deployment (one transaction, so `admin` cannot be front-run):
 *   await Token.compile();
 *   const tx = await Mina.transaction({ sender, fee }, async () => {
 *     AccountUpdate.fundNewAccount(sender);
 *     await new Token(zkAppAddress).deploy({ admin, symbol: 'TKN' });
 *   });
 *   await tx.prove();
 *   await tx.sign([senderKey, zkAppKey]).send();
 */

export type TokenDeployProps = Exclude<DeployArgs, undefined> & {
  /** The only account allowed to mint. Cannot be changed after deployment. */
  admin: PublicKey;
  /** Token symbol shown by wallets and explorers (1 to 6 bytes). Immutable. */
  symbol: string;
};

export class MintEvent extends Struct({ recipient: PublicKey, amount: UInt64 }) {}

export class Token extends TokenContract {
  @state(PublicKey) admin = State<PublicKey>();

  events = { mint: MintEvent };

  async deploy(props: TokenDeployProps) {
    if (props.admin.equals(PublicKey.empty()).toBoolean()) {
      throw Error('Token.deploy: admin must be a real public key');
    }
    const symbolBytes = new TextEncoder().encode(props.symbol).length;
    if (symbolBytes === 0 || symbolBytes > 6) {
      throw Error('Token.deploy: symbol must be 1 to 6 bytes long');
    }

    await super.deploy(props);

    // Set in the same signed deploy account update as the verification key,
    // so nobody can initialize the contract with a different admin.
    this.admin.set(props.admin);
    this.account.tokenSymbol.set(props.symbol);
    this.account.permissions.set({
      ...Permissions.default(),
      access: Permissions.proof(),
      setPermissions: Permissions.impossible(),
      setVerificationKey: Permissions.VerificationKey.impossibleDuringCurrentVersion(),
    });
  }

  /**
   * Mints `amount` new tokens to `recipient`. The admin must sign the
   * transaction. If the recipient has no account for this token yet, the
   * transaction must also pay the account creation fee
   * (`AccountUpdate.fundNewAccount(feePayer)`).
   */
  @method
  async mint(recipient: PublicKey, amount: UInt64) {
    amount.assertGreaterThan(UInt64.zero, 'Token.mint: amount must be positive');

    // The admin comes from on-chain state (the precondition pins it to the
    // stored value) and must sign a dedicated account update. That signature
    // commits to every account update in the transaction, so the recipient and
    // amount cannot be altered, and the nonce/full-commitment handling of
    // createSigned prevents replay.
    const admin = this.admin.getAndRequireEquals();
    AccountUpdate.createSigned(admin);

    this.internal.mint({ address: recipient, amount });
    this.emitEvent('mint', new MintEvent({ recipient, amount }));
  }

  /**
   * Approves token balance changes requested by holders. Debits still need the
   * holder's own authorization (a signature, by default) through the `send`
   * permission of their token account; this method guarantees that no tokens
   * are created or destroyed.
   */
  @method
  async approveBase(forest: AccountUpdateForest) {
    let credits = UInt64.zero;
    let debits = UInt64.zero;

    // `await` is harmless if forEachUpdate is synchronous, and guarantees the
    // loop's constraints are added before the final check if it is not.
    await this.forEachUpdate(forest, (update, usesToken) => {
      const { magnitude, sgn } = update.body.balanceChange;
      const isCredit = usesToken.and(sgn.isPositive());
      const isDebit = usesToken.and(sgn.isPositive().not());
      credits = credits.add(Provable.if(isCredit, UInt64, magnitude, UInt64.zero));
      debits = debits.add(Provable.if(isDebit, UInt64, magnitude, UInt64.zero));
      // Updates are applied in this order: never credit tokens that have not
      // been debited yet.
      credits.assertLessThanOrEqual(
        debits,
        'Token: tokens must be debited before they are credited'
      );
    });

    credits.assertEquals(debits, 'Token: transfers must not create or destroy tokens');
  }
}
