import * as chai from 'chai';
import 'mocha';
import sinon from 'sinon';

import { AuthzConfigError, DecisionAudit, runWithPrincipal } from '@spinajs/authz';
import type { AccessPlan, Principal } from '@spinajs/authz';
import { RecordingAudit, testHost } from '@spinajs/authz-testing';
import { BelongsTo, HasMany, HasManyToMany, ModelBase, Recursive, Relation, SingleRelation } from '@spinajs/orm';

import { AccessResource, PlanTermCompiler } from '../../src/index.js';
import { TestDb } from '../support/db.js';
import { createAncestorTable, dropAncestorTable } from '../support/ancestors.js';
import { FlagTerm } from '../support/flag-term.js';

const expect = chai.expect;

const alice: Principal = { type: 'user', id: 'alice', authenticated: true, source: 'test', attributes: {} };
const green: AccessPlan = { kind: 'filter', permit: [{ op: 'test.flag', args: { flag: 'green' } }], deny: [] };

// Builders are thenables, not Promises.
type Q = PromiseLike<ModelBase[]> & {
  accessible(p: string): Q;
  within(r: object): Q;
  withAccess(p: string[]): Q;
  withFields(p: string): Q;
  populate(relation: string, callback: (this: Q) => void): Q;
  leftJoin(relation: string, on: (this: Q) => void, queryCallback: (this: Q) => void): Q;
  where(column: string, value: unknown): Q;
};
type ListPopulate = { populate(callback: (this: Q) => void): Promise<void> };
type M = Omit<typeof ModelBase, 'query'> & { query(): Q };

const marks: Record<string, (q: Q, permission: string) => void> = {
  accessible: (q, p) => {
    q.accessible(p);
  },
  within: (q) => {
    q.within({ type: 'project', id: 'p1' });
  },
  withAccess: (q, p) => {
    q.withAccess([p]);
  },
  withFields: (q, p) => {
    q.withFields(p);
  },
};

const listOf = (rows: ModelBase[], relation: string) => rows.map((r) => [...(r as unknown as Record<string, Iterable<{ id: unknown }>>)[relation]].map((x) => String(x.id)).sort());

describe('authz marks in a populate callback', function () {
  this.timeout(60000);
  let db: TestDb;
  const undo: (() => void)[] = [];
  let Campaign: M;
  let Note: M;
  let Branch: M;

  before(async () => {
    db = await TestDb.open({ postgres: false });
  });

  after(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    undo.push(testHost.registerInRoot(PlanTermCompiler, FlagTerm), testHost.registerInRoot(DecisionAudit, testHost.instance(new RecordingAudit())));
    const service = await (await testHost.domains()).service('root');
    sinon.stub(service, 'accessPlan').resolves(green);
    await createAncestorTable(db, 'sqlite');
    const Label = await db.define({
      name: 'Label',
      columns: { flag: 'TEXT', tag_id: 'TEXT' },
      rows: [
        { id: 'l1', flag: 'green', tag_id: 'r1' },
        { id: 'l2', flag: 'red', tag_id: 'r1' },
      ],
      decorate: (c) => AccessResource('label')(c),
    });
    class TagLabels extends ModelBase {
      @HasMany(Label, { foreignKey: 'tag_id', primaryKey: 'id' })
      public labels!: Relation<ModelBase, ModelBase>;
    }
    const Tag = await db.define({
      base: TagLabels,
      name: 'Tag',
      columns: { flag: 'TEXT' },
      rows: [
        { id: 'g1', flag: 'green' },
        { id: 'r1', flag: 'red' },
      ],
      decorate: (c) => AccessResource('tag')(c),
    });
    class TagLink extends ModelBase {
      @BelongsTo(Tag, 'tag_id', 'id')
      public tag!: SingleRelation<ModelBase>;
    }
    class TagTree extends ModelBase {
      @Recursive()
      @BelongsTo(Tag, 'tag_id', 'id')
      public tag!: SingleRelation<ModelBase>;
    }
    Branch = (await db.define({ base: TagTree, name: 'Branch', columns: { tag_id: 'TEXT' } })) as M;
    const CampaignTag = await db.define({
      base: TagLink,
      name: 'CampaignTag',
      columns: { campaign_id: 'TEXT', tag_id: 'TEXT' },
      rows: [
        { id: 'j1', campaign_id: 'c1', tag_id: 'g1' },
        { id: 'j2', campaign_id: 'c1', tag_id: 'r1' },
      ],
    });
    const Offer = await db.define({
      base: TagLink,
      name: 'Offer',
      columns: { flag: 'TEXT', campaign_id: 'TEXT', tag_id: 'TEXT' },
      rows: [
        { id: 'o1', flag: 'green', campaign_id: 'c1', tag_id: 'r1' },
        { id: 'o2', flag: 'red', campaign_id: 'c1', tag_id: 'g1' },
        { id: 'o3', flag: 'red', campaign_id: 'c2', tag_id: 'g1' },
      ],
      decorate: (c) => AccessResource('offer')(c),
    });
    Note = (await db.define({
      base: TagLink,
      name: 'Note',
      columns: { flag: 'TEXT', tag_id: 'TEXT' },
      rows: [{ id: 'n1', flag: 'green', tag_id: 'r1' }],
      decorate: (c) => AccessResource('note')(c),
    })) as M;
    class CampaignLinks extends ModelBase {
      @HasMany(Offer, { foreignKey: 'campaign_id', primaryKey: 'id' })
      public offers!: Relation<ModelBase, ModelBase>;

      @HasManyToMany(CampaignTag, Tag, { targetModelPKey: 'id', sourceModelPKey: 'id', junctionModelTargetPk: 'tag_id', junctionModelSourcePk: 'campaign_id' })
      public tags!: Relation<ModelBase, ModelBase>;
    }
    Campaign = (await db.define({
      base: CampaignLinks,
      name: 'Campaign',
      columns: { title: 'TEXT' },
      rows: [
        { id: 'c1', title: 'one' },
        { id: 'c2', title: 'two' },
      ],
    })) as M;
  });

  afterEach(async () => {
    sinon.restore();
    for (const fn of undo.splice(0).reverse()) fn();
    await testHost.resetRoot();
    await db.clear();
    await dropAncestorTable(db, 'sqlite');
  });

  const as = <T>(fn: () => PromiseLike<T>) => runWithPrincipal(alice, async () => fn());

  it('.accessible() filters a hasMany relation by the plan', async () => {
    const rows = await as(() =>
      Campaign.query().populate('offers', function () {
        this.accessible('offer:read');
      }),
    );
    expect(listOf(rows, 'offers')).to.deep.equal([['o1'], []]);
  });

  it('.within() and .withAccess() are accepted on a hasMany relation', () => {
    expect(() =>
      Campaign.query().populate('offers', function () {
        this.within({ type: 'project', id: 'p1' }).withAccess(['offer:read']);
      }),
    ).not.to.throw();
  });

  for (const [name, mark] of Object.entries(marks)) {
    it(`.${name}() on a belongsTo relation throws and names the relation`, () => {
      expect(() =>
        Note.query().populate('tag', function () {
          mark(this, 'tag:read');
        }),
      ).to.throw(AuthzConfigError, /relation "tag" is a belongsTo/);
    });

    it(`.${name}() on a many-to-many relation throws and names the relation`, () => {
      expect(() =>
        Campaign.query().populate('tags', function () {
          mark(this, 'tag:read');
        }),
      ).to.throw(AuthzConfigError, /relation "tags" is many-to-many/);
    });
  }

  it('.accessible() on a belongsTo relation nested in a hasMany throws', () => {
    expect(() =>
      Campaign.query().populate('offers', function () {
        this.populate('tag', function () {
          this.accessible('tag:read');
        });
      }),
    ).to.throw(AuthzConfigError, /relation "tag" is a belongsTo/);
  });

  it('.accessible() on a belongsTo reached through a dotted path throws', () => {
    expect(() =>
      Campaign.query().populate('offers.tag', function () {
        this.accessible('tag:read');
      }),
    ).to.throw(AuthzConfigError, /relation "tag" is a belongsTo/);
  });

  it('.accessible() filters a hasMany relation under a belongsTo', async () => {
    const rows = await as(() =>
      Note.query().populate('tag.labels', function () {
        this.accessible('label:read');
      }),
    );
    const tags = rows.map((n) => (n as unknown as { tag: { Value: ModelBase } }).tag.Value);
    expect(listOf(tags, 'labels')).to.deep.equal([['l1']]);
  });

  it('.accessible() on a recursive belongsTo throws: its descendants would not be filtered', () => {
    expect(() =>
      Branch.query().populate('tag', function () {
        this.accessible('tag:read');
      }),
    ).to.throw(AuthzConfigError, /relation "tag" is recursive/);
  });

  it('.accessible() in a join callback throws and names the join, not a populate', () => {
    let err: unknown;
    try {
      Note.query().leftJoin(
        'tag',
        function () {
          this.where('flag', 'green');
        },
        function () {
          this.accessible('tag:read');
        },
      );
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceOf(AuthzConfigError);
    expect((err as Error).message).to.match(/in a join callback/).and.not.to.match(/populate/);
  });

  it("a many-to-many list's populate() callback throws: the list loads through its junction model's belongsTo", async () => {
    const [campaign] = await as(() => Campaign.query().where('id', 'c1'));
    let err: unknown;
    try {
      await (campaign as unknown as { tags: ListPopulate }).tags.populate(function () {
        this.accessible('tag:read');
      });
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceOf(AuthzConfigError);
    expect((err as Error).message).to.match(/relation "tag" is a belongsTo/);
  });

  it('the message says what to do instead', () => {
    expect(() =>
      Note.query().populate('tag', function () {
        this.accessible('tag:read');
      }),
    ).to.throw(AuthzConfigError, /filter the parent query, populate through a hasMany relation, or load the related rows with their own \.accessible\(\) query/);
  });
});
