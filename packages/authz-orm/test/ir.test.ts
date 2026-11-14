import * as chai from 'chai';
import 'mocha';
import { IREvaluator, MemoryTupleSource, mergeFragments, validateIR } from '@spinajs/authz-ir';
import type { IRFragment } from '@spinajs/authz-ir';
import { ModelBase, Primary } from '@spinajs/orm';

import { AccessResource, Owner, Parent, Relation, Self, ormToIR, registerAccessResource } from '../src/index.js';
import { resetRegistry } from '../src/registry.js';

const expect = chai.expect;

describe('authz-orm: ormToIR', () => {
  afterEach(() => resetRegistry());

  it('turns @Parent, @Owner, @Self and @Relation into column relations of the type', () => {
    @AccessResource('invoice')
    class Invoice extends ModelBase {
      @Primary() public id: number;
      @Parent('project') public project_id: number;
      @Owner() public author_id: string;
      @Relation('reviewer', { typeColumn: 'reviewer_type' }) public reviewer_id: string;
    }
    @AccessResource('profile')
    class Profile extends ModelBase {
      @Primary() public id: number;
      @Self() public user_id: string;
    }
    expect(ormToIR({ classes: [Invoice, Profile], principalTypes: ['user', 'service'] })).to.deep.equal([
      {
        model: 'orm:Invoice',
        types: {
          invoice: {
            relations: {
              parent: { allowed: ['project'], source: { kind: 'column', model: 'Invoice', column: 'project_id' } },
              owner: { allowed: ['user'], source: { kind: 'column', model: 'Invoice', column: 'author_id' } },
              reviewer: { allowed: ['user', 'service'], source: { kind: 'column', model: 'Invoice', column: 'reviewer_id', typeColumn: 'reviewer_type' } },
            },
            permissions: {},
          },
        },
      },
      { model: 'orm:Profile', types: { profile: { relations: { self: { allowed: ['user'], source: { kind: 'column', model: 'Profile', column: 'user_id' } } }, permissions: {} } } },
    ]);
  });

  it('reads every parent column of a multi-parent model and the ancestor closure as parent', () => {
    @AccessResource('file')
    class File extends ModelBase {
      @Primary() public id: number;
      @Parent('folder') public folder_id: number;
      @Parent('org') public org_id: number;
    }
    const [f] = ormToIR({ classes: [File] });
    expect(f.types!.file.relations).to.deep.equal({
      parent_folder_id: { allowed: ['folder'], source: { kind: 'column', model: 'File', column: 'folder_id' } },
      parent_org_id: { allowed: ['org'], source: { kind: 'column', model: 'File', column: 'org_id' } },
      parent: { allowed: ['folder', 'org'], source: { kind: 'ancestor', via: 'orm' } },
    });
  });

  it('includes inherited decorators and registerAccessResource options, and every registered class by default', () => {
    class Base extends ModelBase {
      @Primary() public id: number;
      @Owner() public owner_id: string;
    }
    class Job extends Base {
      @Primary() public id: number;
    }
    registerAccessResource(Job, 'job', { parents: [{ column: 'queue_id', type: 'queue' }] });
    const fragments = ormToIR();
    expect(fragments.map((f) => f.model)).to.deep.equal(['orm:Job']);
    expect(Object.keys(fragments[0].types!.job.relations)).to.deep.equal(['parent', 'owner']);
  });

  it('merges with a permission fragment into an IR the evaluator reads from columns', async () => {
    @AccessResource('invoice')
    class Invoice extends ModelBase {
      @Primary() public id: number;
      @Parent('project') public project_id: number;
      @Owner() public author_id: string;
    }
    const grants: IRFragment = {
      model: 'grants',
      types: { project: { relations: { manager: { allowed: ['user'], source: { kind: 'tuples', store: 't' } } }, permissions: {} }, invoice: { relations: {}, permissions: { read: { union: [{ computed: 'owner' }, { tupleToUserset: { tupleset: 'parent', computed: 'manager' } }] } } } },
      permissions: { 'invoice:read': { type: 'invoice', permit: 'read', source: { origin: 'test' } } },
    };
    const { ir, conflicts } = mergeFragments([...ormToIR({ classes: [Invoice] }), grants]);
    expect(conflicts).to.deep.equal([]);
    expect(validateIR(ir)).to.deep.equal([]);
    const i1 = { type: 'invoice', id: 'i1' };
    const data = new MemoryTupleSource(ir).setColumn('Invoice', 'author_id', i1, { type: 'user', id: 'ann' }).setColumn('Invoice', 'project_id', i1, { type: 'project', id: 'p1' }).add({ type: 'project', id: 'p1' }, 'manager', { type: 'user', id: 'max' });
    const ev = new IREvaluator(ir, data);
    for (const [who, truth] of [['ann', 'allow'], ['max', 'allow'], ['eve', 'deny']] as const) {
      expect((await ev.check({ principal: { type: 'user', id: who }, permission: 'invoice:read', resource: i1 })).truth, who).to.equal(truth);
    }
  });
});
