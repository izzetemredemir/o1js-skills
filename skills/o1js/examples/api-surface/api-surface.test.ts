// Pins the o1js 3.1 API facts the skill relies on: what exists, what was removed, and defaults that bite.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as o1js from 'o1js';
import {
  Encryption,
  Field,
  Int64,
  Mina,
  Poseidon,
  Provable,
  UInt32,
  UInt64,
  VerificationKey,
} from 'o1js';

const hasMember = (value: object, key: string) => key in value;

describe('networks', () => {
  it('Mina.Network(url) defaults to devnet, so mainnet needs networkId', () => {
    assert.equal(Mina.Network('http://127.0.0.1:1/graphql').getNetworkId(), 'devnet');
    const mainnet = Mina.Network({ networkId: 'mainnet', mina: 'http://127.0.0.1:1/graphql' });
    assert.equal(mainnet.getNetworkId(), 'mainnet');
  });

  it('LocalBlockchain is async and test accounts carry their key', async () => {
    const local = await Mina.LocalBlockchain({ proofsEnabled: false });
    const [alice] = local.testAccounts;
    assert.ok(alice.key.toPublicKey().equals(alice).toBoolean());
  });
});

describe('removed or moved exports', () => {
  for (const name of ['isReady', 'shutdown', 'CircuitValue', 'Token', 'TokenContractV2', 'TransactionCost']) {
    it(`${name} is not exported`, () => assert.equal(hasMember(o1js, name), false));
  }

  it('fetchActions is only available as Mina.fetchActions', () => {
    assert.equal(hasMember(o1js, 'fetchActions'), false);
    assert.equal(typeof Mina.fetchActions, 'function');
    assert.equal(typeof o1js.fetchEvents, 'function');
  });

  it('IndexedMerkleMap is a top-level export, OffchainState is still Experimental', () => {
    assert.equal(typeof o1js.IndexedMerkleMap, 'function');
    assert.equal(hasMember(o1js, 'OffchainState'), false);
    assert.equal(typeof o1js.Experimental.OffchainState, 'function');
  });

  it('V2-suffixed names were promoted to the plain names', () => {
    assert.equal(hasMember(Encryption, 'encryptV2'), false);
    assert.equal(typeof Encryption.encrypt, 'function');
    assert.equal(hasMember(Int64.prototype, 'divV2'), false);
  });

  it('old comparison and helper methods are gone', () => {
    assert.equal(hasMember(UInt64.prototype, 'lt'), false);
    assert.equal(typeof UInt64.prototype.lessThan, 'function');
    assert.equal(hasMember(Field.prototype, 'isZero'), false);
  });
});

describe('provable types', () => {
  it('bigint conversion is spelled differently per type', () => {
    assert.equal(UInt64.from(5).toBigInt(), 5n);
    assert.equal(UInt32.from(5).toBigint(), 5n);
    assert.equal(Int64.from(-5).toBigint(), -5n);
    assert.equal(hasMember(UInt32.prototype, 'toBigInt'), false);
  });

  it('Poseidon.hashAnyLength is not the same function as Poseidon.hash', () => {
    const input = [Field(1), Field(2)];
    assert.notDeepEqual(Poseidon.hashAnyLength(input), Poseidon.hash(input));
  });

  it('Provable.equal takes the type as its first argument', () => {
    assert.ok(Provable.equal(Field, Field(1), Field(1)).toBoolean());
  });
});

describe('verification keys', () => {
  it('VerificationKey.toJSON returns { data, hash }', () => {
    const json = VerificationKey.toJSON(VerificationKey.dummySync());
    assert.deepEqual(Object.keys(json).sort(), ['data', 'hash']);
  });
});
