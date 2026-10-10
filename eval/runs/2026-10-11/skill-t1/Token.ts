import {
  AccountUpdateForest,
  DeployArgs,
  Int64,
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
 * Admin-minted custom token for Mina (o1js 3.1, after the Mesa hard fork).
 *
 * Rules
 * - `admin` is chosen at deploy time and is the only key that can mint. The admin must sign the transaction
 *   (`this.sender.getAndRequireSignature()`), so nobody can merely claim to be the admin.
 * - Holders move tokens with the inherited `transfer(from, to, amount)`. It needs the sending holder's
 *   signature and goes through `approveBase`.
 * - Nobody else can create tokens. The token contract's account has `access: proof()`, so every token balance
 *   change must be approved by a proof of `mint` or `approveBase`. A token-owner update built by hand is
 *   rejected, with or without the token contract's private key. `approveBase` rejects any credit that is not
 *   covered by an earlier debit (flash mint) and requires all balance changes to sum to zero.
 *
 * Irreversible by design (only the hard-fork fallback described below relaxes them):
 * - the verification key cannot change until the next hard fork (`impossibleDuringCurrentVersion`), so a bug
 *   cannot be patched before then;
 * - the permissions, the token symbol and the admin can never change.
 *
 * Before deploying to mainnet
 * - Run the tests with proofs enabled (environment variable PROOFS=1), with o1js 3.1.0 or later.
 * - Connect with `Mina.Network({ networkId: 'mainnet', mina, archive })`. Without `networkId` the network
 *   defaults to devnet, and mainnet rejects the signatures.
 * - Keep the token contract's private key offline and backed up. After a hard fork, until the verification key
 *   is updated, the protocol relaxes `access: proof` and `setVerificationKey` to `signature`. During that window
 *   this key can mint, and it is the only way to upgrade the contract.
 * - After deploying, check the account's permissions and `admin` on chain. `deploy()` is authorized by a
 *   signature, not a proof, so a matching verification key alone does not prove that an address runs this
 *   token with this configuration.
 */

export const TokenErrors = {
  emptyAdmin: 'Token: the admin must not be the empty public key',
  notAdmin: 'Token: only the admin can mint',
  flashMint: 'Token: credits must never exceed the debits before them',
  unbalanced: 'Token: balance changes must sum to zero',
  holderPermissions: 'Token: token accounts must keep their access and receive permissions at none',
} as const;

/** Emitted on every mint so that indexers can follow the supply. */
export class MintEvent extends Struct({ to: PublicKey, amount: UInt64 }) {}

export type TokenDeployArgs = DeployArgs & {
  /** The only key allowed to mint. It cannot be changed after deployment. */
  admin: PublicKey;
  /** Token symbol shown by wallets, at most 6 characters. It cannot be changed after deployment. */
  symbol: string;
};

type AuthRequired = ReturnType<typeof Permissions.none>;

/** True if `auth` is exactly `Permissions.none()`. */
function isNone(auth: AuthRequired) {
  const none = Permissions.none();
  return auth.constant
    .equals(none.constant)
    .and(auth.signatureNecessary.equals(none.signatureNecessary))
    .and(auth.signatureSufficient.equals(none.signatureSufficient));
}

export class Token extends TokenContract {
  @state(PublicKey) admin = State<PublicKey>();

  events = { mint: MintEvent };

  async deploy(args: TokenDeployArgs) {
    // An empty admin would make minting impossible forever.
    args.admin.isEmpty().assertFalse(TokenErrors.emptyAdmin);

    // TokenContract.deploy() requires a new account, sets the verification key and runs init().
    await super.deploy(args);
    this.admin.set(args.admin);
    this.account.tokenSymbol.set(args.symbol);

    // Set every permission explicitly. Spreading Permissions.default() alone would reset `access` to none, so
    // anyone could mint by creating the token owner's account update. TokenContract's own proofOrSignature would
    // let whoever holds this contract's private key sign around approveBase. Only proof() closes both.
    this.account.permissions.set({
      ...Permissions.default(),
      access: Permissions.proof(),
      editState: Permissions.proof(),
      send: Permissions.proof(),
      setVerificationKey: Permissions.VerificationKey.impossibleDuringCurrentVersion(),
      setPermissions: Permissions.impossible(),
      setZkappUri: Permissions.impossible(),
      setTokenSymbol: Permissions.impossible(),
      setTiming: Permissions.impossible(),
      setVotingFor: Permissions.impossible(),
      incrementNonce: Permissions.impossible(),
    });
  }

  @method async mint(to: PublicKey, amount: UInt64) {
    const admin = this.admin.getAndRequireEquals();
    // getAndRequireSignature() makes the transaction carry the sender's signature. getUnconstrained() would let
    // the prover pick any sender.
    this.sender.getAndRequireSignature().equals(admin).assertTrue(TokenErrors.notAdmin);
    this.internal.mint({ address: to, amount });
    this.emitEvent('mint', new MintEvent({ to, amount }));
  }

  /**
   * Approves every token movement other than a mint: `transfer`, `approveAccountUpdate(s)`.
   * Handles at most TokenContract.MAX_ACCOUNT_UPDATES (9) account updates per call.
   */
  @method async approveBase(forest: AccountUpdateForest) {
    let total = Int64.zero;

    this.forEachUpdate(forest, (update, usesToken) => {
      // A holder must not lock their token account (for example `receive: impossible`, which would block
      // transfers to it). Other permission changes, such as deploying a zkApp on a token account, stay possible.
      const { isSome, value } = update.update.permissions;
      const keepsOpen = isNone(value.access).and(isNone(value.receive));
      usesToken.and(isSome).and(keepsOpen.not()).assertFalse(TokenErrors.holderPermissions);

      // The running total of this token's balance changes may go negative (debits first) but never positive.
      // Otherwise tokens that nobody minted would exist in the middle of the transaction (flash mint).
      total = total.add(Provable.if(usesToken, update.balanceChange, Int64.zero));
      const totalIsPositive = total.sgn.isPositive().and(total.magnitude.equals(UInt64.zero).not());
      totalIsPositive.assertFalse(TokenErrors.flashMint);
    });

    // No tokens created or destroyed outside `mint`.
    total.assertEquals(Int64.zero, TokenErrors.unbalanced);
  }
}
