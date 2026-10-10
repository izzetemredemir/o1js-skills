// Compile-time checks: every `@ts-expect-error` below marks an outdated pattern that LLMs still write.
// If o1js ever accepts one of them again, `tsc` fails because the directive becomes unused.
import { AccountUpdate, Bool, Field, Mina, Permissions, PublicKey, SmartContract, UInt32, UInt64, ZkProgram, method } from 'o1js';

export function permissionChecks() {
  const ok = { ...Permissions.default(), setVerificationKey: Permissions.VerificationKey.impossibleDuringCurrentVersion() };
  // @ts-expect-error setVerificationKey takes a Permissions.VerificationKey.* value, not Permissions.impossible()
  const wrong = { ...Permissions.default(), setVerificationKey: Permissions.impossible() } satisfies typeof ok;
  return [ok, wrong];
}

export function createIfReturnsOptional(address: PublicKey) {
  const optional = AccountUpdate.createIf(Bool(true), address);
  // @ts-expect-error since 3.1 createIf returns an OptionalAccountUpdate; use `.value` for the AccountUpdate
  const update: AccountUpdate = optional;
  return [optional.value, update];
}

export function assertionMessages(a: UInt64, b: UInt32) {
  a.assertLessThanOrEqual(a, 'comparisons on UInt64 take a message');
  Field(1).assertEquals(1, 'Field.assertEquals takes a message');
  // @ts-expect-error UInt64.assertEquals takes no message argument (UInt8, Int64, Field and Bool do)
  a.assertEquals(a, 'not allowed');
  // @ts-expect-error UInt32.assertEquals takes no message argument either
  b.assertEquals(b, 'not allowed');
}

export async function transactionCallbackMustBeAsync(sender: PublicKey) {
  // @ts-expect-error the transaction callback must be async
  await Mina.transaction(sender, () => {});
}

export class SyncMethod extends SmartContract {
  // @ts-expect-error @method functions must be async
  @method inc() {}
}

export const Program = ZkProgram({
  name: 'type-checks',
  publicInput: Field,
  publicOutput: Field,
  methods: {
    double: {
      privateInputs: [],
      async method(x: Field) {
        return { publicOutput: x.mul(2) };
      },
    },
    wrongReturn: {
      privateInputs: [],
      // @ts-expect-error methods return { publicOutput }, not the bare value
      async method(x: Field) {
        return x.mul(2);
      },
    },
  },
});

export async function proverResult() {
  const { proof } = await Program.double(Field(1));
  const result = await Program.double(Field(1));
  // @ts-expect-error provers resolve to { proof, auxiliaryOutput }, not to the proof itself
  result.publicOutput;
  return proof;
}
