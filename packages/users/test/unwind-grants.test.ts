import 'mocha';
import { expect } from 'chai';
import { AccessControl } from 'accesscontrol';

import { _unwindGrants, _combineGrants } from '../src/util.js';

/**
 * `_unwindGrants` flattens the `$extend` chain of a role into the single grants map that
 * gets shipped to clients. Clients rebuild an ACL from it, so the map has to answer the
 * same questions as `ac.can(role)` does server-side — every test here pins one way the
 * flattening used to diverge from that.
 */
describe('_unwindGrants', () => {
  const grants = {
    contentmanager: {
      $extend: ['route.home', 'manager.player_content'],
      EntriesGroup: { 'create:any': ['*'] },
      ContentEntries: { 'create:any': ['*'] },
    },
    'manager.player_content': {
      EntriesGroup: { 'read:any': ['*'], 'update:any': ['*'], 'delete:any': ['*'] },
      ContentEntries: { 'read:any': ['*'], 'update:any': ['*'], 'delete:any': ['*'] },
    },
    'route.home': { RouteHome: { 'read:any': ['*'] } },
  };

  it('keeps the role own actions on a resource an inherited role also grants', () => {
    const unwound = _unwindGrants('contentmanager', grants);

    // create:any comes from the role itself, the other three from manager.player_content —
    // a resource-level merge kept only one side
    expect(unwound.ContentEntries).to.deep.equal({
      'read:any': ['*'],
      'update:any': ['*'],
      'delete:any': ['*'],
      'create:any': ['*'],
    });
    expect(unwound.EntriesGroup).to.have.property('create:any');
    expect(unwound.EntriesGroup).to.have.property('delete:any');
  });

  it('pulls in resources from every inherited role', () => {
    const unwound = _unwindGrants('contentmanager', grants);
    expect(unwound.RouteHome).to.deep.equal({ 'read:any': ['*'] });
  });

  it('does not leak $extend into the resource map', () => {
    expect(_unwindGrants('contentmanager', grants)).to.not.have.property('$extend');
  });

  it('answers like accesscontrol does for the same role', () => {
    const ac = new AccessControl(grants);
    const unwound = _unwindGrants('contentmanager', ac.getGrants());
    const rebuilt = new AccessControl({ _client: unwound }).can('_client');

    for (const resource of ['EntriesGroup', 'ContentEntries']) {
      for (const action of ['createAny', 'readAny', 'updateAny', 'deleteAny'] as const) {
        expect((rebuilt as any)[action](resource).granted, `${action} ${resource}`).to.equal(
          (ac.can('contentmanager') as any)[action](resource).granted,
        );
      }
    }
  });

  it('lets the role override an action inherited from an extended role', () => {
    const g = {
      child: { $extend: ['parent'], Res: { 'read:any': ['name'] } },
      parent: { Res: { 'read:any': ['*'] } },
    };

    expect(_unwindGrants('child', g).Res).to.deep.equal({ 'read:any': ['name'] });
  });

  it('returns an empty map for an unknown role', () => {
    expect(_unwindGrants('nope', grants)).to.deep.equal({});
  });

  it('terminates on a cyclic $extend', () => {
    const g = {
      a: { $extend: ['b'], A: { 'read:any': ['*'] } },
      b: { $extend: ['a'], B: { 'read:any': ['*'] } },
    };

    const unwound = _unwindGrants('a', g);
    expect(unwound.A).to.deep.equal({ 'read:any': ['*'] });
    expect(unwound.B).to.deep.equal({ 'read:any': ['*'] });
  });

  it('does not mutate the source grants', () => {
    const snapshot = JSON.stringify(grants);
    _unwindGrants('contentmanager', grants);
    expect(JSON.stringify(grants)).to.equal(snapshot);
  });
});

describe('_combineGrants', () => {
  it('merges per action across roles instead of replacing the resource', () => {
    const combined = _combineGrants(
      { Res: { 'read:any': ['*'] } },
      { Res: { 'create:any': ['*'] }, Other: { 'read:any': ['*'] } },
    );

    expect(combined.Res).to.deep.equal({ 'read:any': ['*'], 'create:any': ['*'] });
    expect(combined.Other).to.deep.equal({ 'read:any': ['*'] });
  });

  it('returns an empty map when given nothing', () => {
    expect(_combineGrants()).to.deep.equal({});
  });
});
