import * as chai from 'chai';
import 'mocha';

import { Ignore, Uuid, DiscriminationMap, BelongsTo, Recursive, Primary } from '../src/decorators.js';
import { extractModelDescriptor } from '../src/descriptor.js';
import { ModelBase } from '../src/model.js';
import { IColumnDescriptor } from '../src/interfaces.js';
import { InvalidArgument } from '@spinajs/exceptions';

const expect = chai.expect;

/**
 * A model subclass gets its OWN descriptor, collapsed from its parent's. The
 * merger rebuilds Columns / Relations / the option objects one level deep but
 * their ELEMENTS are shared by reference with the parent. Several decorators
 * ( @Ignore, @Uuid, @Recursive, @DiscriminationMap, ... ) mutate a found
 * element in place - which, on an INHERITED member, would write straight through
 * to the package model's descriptor. These tests pin that it does not.
 */
describe('Model descriptor inheritance isolation', () => {
  it('a subclass @Ignore on an inherited column does not mutate the parent column', () => {
    class ParentColumnModel extends ModelBase {
      @Uuid()
      public Token: string;
    }

    class ChildColumnModel extends ParentColumnModel {
      // re-decorates the SAME column the parent already declared
      @Ignore()
      public Token: string;
    }

    const parent = extractModelDescriptor(ParentColumnModel)!;
    const child = extractModelDescriptor(ChildColumnModel)!;

    const parentToken = parent.Columns.find((c: IColumnDescriptor) => c.Name === 'Token')!;
    const childToken = child.Columns.find((c: IColumnDescriptor) => c.Name === 'Token')!;

    // the child sees its inherited column and its own change to it
    expect(childToken.Uuid).to.eq(true);
    expect(childToken.Ignore).to.eq(true);

    // but the parent's column object is untouched - and is a distinct object
    expect(parentToken).to.not.equal(childToken);
    expect(parentToken.Ignore).to.not.eq(true);
  });

  it('a subclass @DiscriminationMap does not mutate the parent discrimination map', () => {
    class DiscA extends ModelBase {}
    class DiscB extends ModelBase {}

    @DiscriminationMap('type', [{ Key: 'a', Value: DiscA }])
    class ParentDiscModel extends ModelBase {}

    @DiscriminationMap('kind', [{ Key: 'b', Value: DiscB }])
    class ChildDiscModel extends ParentDiscModel {}

    const parent = extractModelDescriptor(ParentDiscModel)!;
    const child = extractModelDescriptor(ChildDiscModel)!;

    expect(child.DiscriminationMap.Field).to.eq('kind');

    // the parent's nested map object must not have been rewritten in place
    expect(parent.DiscriminationMap).to.not.equal(child.DiscriminationMap);
    expect(parent.DiscriminationMap.Field).to.eq('type');
  });

  it('a subclass @Recursive on an inherited relation does not mutate the parent relation', () => {
    class ParentRelationModel extends ModelBase {
      @BelongsTo('SomeTarget')
      public owner: unknown;
    }

    class ChildRelationModel extends ParentRelationModel {
      // flags the INHERITED relation recursive; the parent must stay non-recursive
      @Recursive()
      public owner: unknown;
    }

    const parent = extractModelDescriptor(ParentRelationModel)!;
    const child = extractModelDescriptor(ChildRelationModel)!;

    const parentRel = parent.Relations.get('owner')!;
    const childRel = child.Relations.get('owner')!;

    expect(childRel.Recursive).to.eq(true);
    expect(parentRel).to.not.equal(childRel);
    expect(parentRel.Recursive).to.eq(false);
  });
});

describe('@Ignore() on a primary key', () => {
  const message = /@Ignore\(\) cannot mark primary key Id of model \w+: a primary key is always persisted/;

  it('throws whichever of @Ignore() and @Primary() runs first', () => {
    expect(() => {
      class IgnoredBelow extends ModelBase {
        @Ignore()
        @Primary()
        public Id: number;
      }
      return IgnoredBelow;
    }).to.throw(message);

    expect(() => {
      class IgnoredAbove extends ModelBase {
        @Primary()
        @Ignore()
        public Id: number;
      }
      return IgnoredAbove;
    }).to.throw(message);
  });

  it('throws on a child @Primary() over a property the parent ignores', () => {
    class IgnoringParent extends ModelBase {
      @Ignore()
      public Id: number;
    }

    expect(() => {
      class KeyingChild extends IgnoringParent {
        @Primary()
        public Id: number;
      }
      return KeyingChild;
    }).to.throw(InvalidArgument, message);
  });

  it('throws on a primary key inherited from the parent model', () => {
    class KeyedParent extends ModelBase {
      @Primary()
      public Id: number;
    }

    expect(() => {
      class KeyedChild extends KeyedParent {
        @Ignore()
        public Id: number;
      }
      return KeyedChild;
    }).to.throw(message);
  });
});
