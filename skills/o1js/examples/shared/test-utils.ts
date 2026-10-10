import { Mina, PublicKey, type Types } from 'o1js';

export const proofsEnabled = process.env.PROOFS === '1';

type AuthRequired = Types.AuthRequired;

/** Human-readable name of a permission, e.g. to assert on the `access` permission of a deployed account. */
export function authName(auth: AuthRequired) {
  const constant = auth.constant.toBoolean();
  const necessary = auth.signatureNecessary.toBoolean();
  const sufficient = auth.signatureSufficient.toBoolean();
  if (constant) return sufficient ? 'none' : 'impossible';
  if (necessary) return sufficient ? 'signature' : 'proofAndSignature';
  return sufficient ? 'proofOrSignature' : 'proof';
}

export function permissionsOf(address: PublicKey, tokenId?: Types.TokenId) {
  return Mina.getAccount(address, tokenId).permissions;
}
