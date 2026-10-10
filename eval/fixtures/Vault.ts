import {
  AccountUpdate,
  Bool,
  DeployArgs,
  Field,
  Permissions,
  Poseidon,
  PublicKey,
  Signature,
  SmartContract,
  State,
  UInt64,
  method,
  state,
} from 'o1js';

export class Vault extends SmartContract {
  @state(PublicKey) owner = State<PublicKey>();
  @state(Field) secretHash = State<Field>();
  @state(UInt64) totalDeposits = State<UInt64>();
  @state(Bool) paused = State<Bool>();

  async deploy(args?: DeployArgs) {
    await super.deploy(args);
    this.account.permissions.set({
      ...Permissions.default(),
      send: Permissions.proofOrSignature(),
    });
  }

  @method async setOwner(newOwner: PublicKey) {
    const owner = this.owner.getAndRequireEquals();
    this.sender.getUnconstrained().assertEquals(owner);
    this.owner.set(newOwner);
  }

  @method async deposit(amount: UInt64, isBonus: Bool) {
    const total = this.totalDeposits.getAndRequireEquals();
    let credited = amount;
    if (isBonus) {
      credited = amount.add(UInt64.from(100));
    }
    const payer = AccountUpdate.createSigned(this.sender.getAndRequireSignature());
    payer.send({ to: this.address, amount });
    this.totalDeposits.set(total.add(credited));
  }

  @method async withdrawWithSecret(amount: UInt64, secret: Field) {
    this.paused.requireNothing();
    this.paused.get().assertFalse();
    const expected = this.secretHash.getAndRequireEquals();
    Poseidon.hash([secret]).equals(expected);
    this.send({ to: this.sender.getAndRequireSignature(), amount });
  }

  @method async withdrawWithApproval(amount: UInt64, approval: Signature) {
    const owner = this.owner.getAndRequireEquals();
    approval.verify(owner, [amount.value]).assertTrue();
    this.send({ to: this.sender.getAndRequireSignature(), amount });
  }

  @method async checkSolvency(assets: Field, liabilities: Field) {
    assets.sub(liabilities).assertGreaterThanOrEqual(Field(0));
  }
}
