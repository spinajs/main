/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from 'chai';
import 'mocha';
import { IdentityMap, identityKey } from '../src/identity-map.js';
import 'reflect-metadata';
import { createDefaultModelDescriptor } from '../src/descriptor.js';
import { MODEL_DESCTRIPTION_SYMBOL } from '../src/symbols.js';

/**
 * Minimal stand-ins. Undecorated classes have no table to unify on, so each keeps its own
 * bucket — the identity map falls back to the constructor for them.
 */
class Alpha {
  constructor(public PrimaryKeyValue: any) {}
}
class Beta {
  constructor(public PrimaryKeyValue: any) {}
}

/**
 * Two constructors, one table — the `@DiscriminationMap` shape.
 *
 * The descriptor is attached directly rather than via `@Model`, because the decorators also
 * register the class in the global model registry and `model.test.ts` counts the models
 * loaded from disk.
 */
function asModel<T extends object>(ctor: T, table: string): T {
  const descriptor = createDefaultModelDescriptor();
  descriptor.TableName = table;
  descriptor.Name = table;
  Reflect.defineMetadata(MODEL_DESCTRIPTION_SYMBOL, descriptor, ctor);
  return ctor;
}

class Vehicle {
  constructor(public PrimaryKeyValue: any) {}
}
class Car extends Vehicle {}
class Garage {
  constructor(public PrimaryKeyValue: any) {}
}

asModel(Vehicle, 'vehicle');
asModel(Car, 'vehicle');
asModel(Garage, 'garage');

describe('IdentityMap', () => {
  it('returns undefined for an unknown key', () => {
    const map = new IdentityMap();
    expect(map.get(Alpha as any, 1)).to.equal(undefined);
    expect(map.has(Alpha as any, 1)).to.equal(false);
  });

  it('add returns the model it stored', () => {
    const map = new IdentityMap();
    const a = new Alpha(1) as any;

    expect(map.add(a)).to.equal(a);
    expect(map.get(Alpha as any, 1)).to.equal(a);
    expect(map.has(Alpha as any, 1)).to.equal(true);
  });

  it('add returns the already-registered instance for the same constructor and key', () => {
    const map = new IdentityMap();
    const first = new Alpha(1) as any;
    const second = new Alpha(1) as any;

    map.add(first);

    expect(map.add(second)).to.equal(first);
    expect(map.Size).to.equal(1);
  });

  it('keys on constructor identity, not class name', () => {
    const map = new IdentityMap();
    const a = new Alpha(1) as any;
    const b = new Beta(1) as any;

    map.add(a);
    map.add(b);

    expect(map.get(Alpha as any, 1)).to.equal(a);
    expect(map.get(Beta as any, 1)).to.equal(b);
    expect(map.Size).to.equal(2);
  });

  it('does not confuse a numeric key with the equivalent string key', () => {
    const map = new IdentityMap();
    const numeric = new Alpha(1) as any;
    const textual = new Alpha('1') as any;

    map.add(numeric);
    map.add(textual);

    expect(map.get(Alpha as any, 1)).to.equal(numeric);
    expect(map.get(Alpha as any, '1')).to.equal(textual);
    expect(map.Size).to.equal(2);
  });

  it('does not register a model without a primary key', () => {
    const map = new IdentityMap();
    const a = new Alpha(undefined) as any;
    const b = new Alpha(null) as any;

    expect(map.add(a)).to.equal(a);
    expect(map.add(b)).to.equal(b);
    expect(map.Size).to.equal(0);
  });

  it('treats a primary key of 0 as a real key', () => {
    const map = new IdentityMap();
    const a = new Alpha(0) as any;

    map.add(a);

    expect(map.get(Alpha as any, 0)).to.equal(a);
    expect(map.Size).to.equal(1);
  });

  it('clear empties it', () => {
    const map = new IdentityMap();
    map.add(new Alpha(1) as any);
    map.clear();

    expect(map.Size).to.equal(0);
    expect(map.get(Alpha as any, 1)).to.equal(undefined);
  });

  // `PrimaryKeyValue` is a tuple for a composite-key model, so the map has to handle arrays.
  describe('composite keys', () => {
    it('registers and finds a model by its key tuple', () => {
      const map = new IdentityMap();
      const a = new Alpha([1, 'x']) as any;

      map.add(a);

      expect(map.get(Alpha as any, [1, 'x'])).to.equal(a);
      expect(map.has(Alpha as any, [1, 'x'])).to.equal(true);
      expect(map.Size).to.equal(1);
    });

    it('treats two different tuples as different identities', () => {
      const map = new IdentityMap();
      const a = new Alpha([1, 'x']) as any;
      const b = new Alpha([1, 'y']) as any;

      map.add(a);
      map.add(b);

      expect(map.get(Alpha as any, [1, 'x'])).to.equal(a);
      expect(map.get(Alpha as any, [1, 'y'])).to.equal(b);
      expect(map.Size).to.equal(2);
    });

    it('does not register a tuple with a missing part', () => {
      const map = new IdentityMap();

      map.add(new Alpha([1, undefined]) as any);
      map.add(new Alpha([null, 'x']) as any);

      expect(map.Size).to.equal(0);
    });
  });

  describe('identityKey', () => {
    it('returns null for null and undefined', () => {
      expect(identityKey(null)).to.equal(null);
      expect(identityKey(undefined)).to.equal(null);
    });

    it('tags the key with its type so 1 and "1" differ', () => {
      expect(identityKey(1)).to.not.equal(identityKey('1'));
    });

    it('is stable for the same value', () => {
      expect(identityKey('abc')).to.equal(identityKey('abc'));
      expect(identityKey(7)).to.equal(identityKey(7));
    });

    it('hexes a Buffer key', () => {
      expect(identityKey(Buffer.from([0xde, 0xad]))).to.equal(identityKey(Buffer.from([0xde, 0xad])));
      expect(identityKey(Buffer.from([0xde, 0xad]))).to.not.equal(identityKey(Buffer.from([0xbe, 0xef])));
    });

    it('is stable for the same key tuple', () => {
      expect(identityKey([1, 'a'])).to.equal(identityKey([1, 'a']));
    });

    // The whole reason a tuple cannot be rendered with String(): `String([1,2])` and
    // `String(['1,2'])` are both "1,2".
    it('cannot be made to collide by moving a separator into a part', () => {
      expect(identityKey([1, 2])).to.not.equal(identityKey(['1,2']));
      expect(identityKey(['a', 'bc'])).to.not.equal(identityKey(['ab', 'c']));
    });

    it('returns null when any part of a tuple is missing', () => {
      expect(identityKey([1, null])).to.equal(null);
      expect(identityKey([undefined, 1])).to.equal(null);
    });

    it('does not confuse a one-element tuple with the bare scalar', () => {
      // A single-column key is read as a scalar everywhere in the ORM, so both spellings
      // must land on the same entry.
      expect(identityKey([1])).to.equal(identityKey(1));
    });
  });

  /**
   * A `@DiscriminationMap` produces several constructors for ONE table, and a subclass
   * instance is still the same row. `SubjectBuilder.buildOrphans` has always keyed on the
   * table for exactly this reason; the identity map keyed on the constructor, so the two
   * disagreed and a row reached once as its base class and once as its subclass produced two
   * entries — and two conflicting subjects for one row.
   */
  describe('rows of one table reached through different constructors', () => {
    it('canonicalizes a discriminated subclass onto the same entry as its base', () => {
      const map = new IdentityMap();
      const base = new Vehicle(1) as any;
      const sub = new Car(1) as any;

      expect(map.add(base)).to.equal(base);
      expect(map.add(sub)).to.equal(base);
      expect(map.Size).to.equal(1);
    });

    it('still separates models that map to different tables', () => {
      const map = new IdentityMap();
      const car = new Car(1) as any;
      const other = new Garage(1) as any;

      map.add(car);
      map.add(other);

      expect(map.Size).to.equal(2);
      expect(map.get(Car as any, 1)).to.equal(car);
      expect(map.get(Garage as any, 1)).to.equal(other);
    });
  });
});
