import * as chai from 'chai';
import 'mocha';

import { Ignore, Uuid, DiscriminationMap, BelongsTo, Recursive } from '../src/decorators.js';
import { extractModelDescriptor } from '../src/descriptor.js';
import { ModelBase } from '../src/model.js';
import { IColumnDescriptor } from '../src/interfaces.js';

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
      public pk: string;
    }

    class ChildColumnModel extends ParentColumnModel {
      // re-decorates the SAME column the parent already declared
      @Ignore()
      public pk: string;
    }

    const parent = extractModelDescriptor(ParentColumnModel)!;
    const child = extractModelDescriptor(ChildColumnModel)!;

    const parentPk = parent.Columns.find((c: IColumnDescriptor) => c.Name === 'pk')!;
    const childPk = child.Columns.find((c: IColumnDescriptor) => c.Name === 'pk')!;

    // the child sees its inherited column and its own change to it
    expect(childPk.Uuid).to.eq(true);
    expect(childPk.Ignore).to.eq(true);

    // but the parent's column object is untouched - and is a distinct object
    expect(parentPk).to.not.equal(childPk);
    expect(parentPk.Ignore).to.not.eq(true);
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
