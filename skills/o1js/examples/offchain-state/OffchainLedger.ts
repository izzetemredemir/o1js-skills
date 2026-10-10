import { Experimental, PublicKey, SmartContract, UInt64, method, state } from 'o1js';

const { OffchainState } = Experimental;

/** Balances live off-chain in a Merkle map; only commitments are on-chain. Experimental in o1js 3.1. */
export const offchainState = OffchainState(
  {
    accounts: OffchainState.Map(PublicKey, UInt64),
    totalSupply: OffchainState.Field(UInt64),
  },
  { logTotalCapacity: 10, maxActionsPerProof: 5 }
);

export class StateProof extends offchainState.Proof {}

export class OffchainLedger extends SmartContract {
  @state(OffchainState.Commitments) offchainStateCommitments = offchainState.emptyCommitments();

  offchainState = offchainState.init(this);

  @method async mint(to: PublicKey, amount: UInt64) {
    const toOption = await this.offchainState.fields.accounts.get(to);
    this.offchainState.fields.accounts.update(to, { from: toOption, to: toOption.orElse(0n).add(amount) });

    const supplyOption = await this.offchainState.fields.totalSupply.get();
    this.offchainState.fields.totalSupply.update({ from: supplyOption, to: supplyOption.orElse(0n).add(amount) });
  }

  @method async transfer(from: PublicKey, to: PublicKey, amount: UInt64) {
    this.sender.getAndRequireSignature().assertEquals(from);
    const fromOption = await this.offchainState.fields.accounts.get(from);
    const fromBalance = fromOption.assertSome('sender has no account');
    const toOption = await this.offchainState.fields.accounts.get(to);

    // Both updates are applied together, and only if both balances are still what we read here.
    // If either changed before settlement, the whole transfer is skipped -- silently.
    this.offchainState.fields.accounts.update(from, { from: fromOption, to: fromBalance.sub(amount) });
    this.offchainState.fields.accounts.update(to, { from: toOption, to: toOption.orElse(0n).add(amount) });
  }

  @method.returns(UInt64) async balanceOf(address: PublicKey) {
    return (await this.offchainState.fields.accounts.get(address)).orElse(0n);
  }

  @method async settle(proof: StateProof) {
    await this.offchainState.settle(proof);
  }
}
