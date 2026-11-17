import 'mocha';
import { expect } from 'chai';

import { irToRebacConfig, readOpenFga, writeOpenFga } from '../../src/index.js';
import type { PolicyIR } from '../../src/index.js';

const NOT_EXPIRED = { params: { 'env.day': 'int', 'env.until': 'int' }, expr: { attr: 'env.day', lt: { ref: 'env.until' } } };
const OFFICE_IP = { params: { 'env.ip': 'string' }, expr: { attr: 'env.ip', eq: '10.0.0.1' } };

const MODEL = `model
  schema 1.1

type user
type group
  relations
    define member: [user]
type folder
  relations
    define viewer: [user]
type doc
  relations
    define parent: [folder with not_expired]
    define viewer: [user, user with office_ip, group#member with office_ip]
    define read: viewer or viewer from parent

# spina:caveat not_expired ${JSON.stringify(NOT_EXPIRED)}
condition not_expired(env_day: int, env_until: int) {
  env_day < env_until
}

# spina:caveat office_ip ${JSON.stringify(OFFICE_IP)}
condition office_ip(env_ip: string) {
  env_ip == "10.0.0.1"
}
`;

const LOSSY = `${MODEL}
type sheet
  relations
    define viewer: [user, user with office_ip]
    define reviewer: [user, user with row_open]
    define approver: [user with ghost, user:* with office_ip]
    define open: viewer but not reviewer
    define signed: approver and viewer

# spina:caveat row_open {"expr":{"attr":"resource.status","eq":"open"},"params":{"resource.status":"string"}}
condition row_open(resource_status: string) {
  resource_status == "open"
}
`;

describe('irToRebacConfig with conditional subject types', () => {
  it('keeps conditional subject types in the with spelling and returns the caveats', () => {
    const config = irToRebacConfig(readOpenFga(MODEL));
    expect(config.namespaces.doc.relations).to.deep.equal({ parent: ['folder with not_expired'], viewer: ['user', 'user with office_ip', 'group#member with office_ip'] });
    expect(config.caveats).to.deep.equal({ not_expired: NOT_EXPIRED, office_ip: OFFICE_IP });
    expect(config.problems).to.deep.equal([]);
  });

  it('drops every subject type whose caveat ReBAC cannot hold or the model does not define, never only its caveat', () => {
    const config = irToRebacConfig(readOpenFga(LOSSY));
    expect(config.caveats).to.have.all.keys('not_expired', 'office_ip');
    expect(config.namespaces.sheet.relations).to.deep.equal({ viewer: ['user', 'user with office_ip'], reviewer: ['user'], approver: [] });
    expect(config.problems).to.deep.equal([
      'caveat row_open: ReBAC caveats read env.* and principal.* only, not resource.status',
      'sheet#reviewer: {"type":"user","caveat":"row_open"} needs caveat row_open, which ReBAC cannot hold',
      'sheet#approver: {"type":"user","caveat":"ghost"} needs caveat ghost, which the model does not define',
      'sheet#approver: ReBAC holds no wildcard subject {"type":"user:*","caveat":"office_ip"}',
      'sheet#open: subtracts sheet#reviewer, which lost subject types: it would grant more than the model',
    ]);
    // A narrowed relation under `and` narrows the permission, which is kept.
    expect(config.namespaces.sheet.permissions).to.deep.equal({ signed: { intersection: ['approver', 'viewer'] } });
  });

  it('finds a narrowed relation behind subject sets and arrows of a subtract', () => {
    const ir = readOpenFga(`${LOSSY}
type binder
  relations
    define sheet: [sheet]
    define team: [group#member, sheet#reviewer]
    define hidden: team or reviewer from sheet
    define open: team but not (reviewer from sheet)
    define shown: team but not hidden
`);
    const config = irToRebacConfig(ir);
    expect(config.namespaces.binder.permissions).to.deep.equal({ hidden: { union: ['team', 'sheet->reviewer'] } });
    expect(config.problems.filter((p) => p.startsWith('binder#'))).to.deep.equal([
      'binder#open: subtracts sheet#reviewer, which lost subject types: it would grant more than the model',
      'binder#shown: subtracts sheet#reviewer, which lost subject types: it would grant more than the model',
    ]);
  });

  it('a caveat with no OpenFGA condition body stays conditional through export and import', () => {
    const ir: PolicyIR = readOpenFga(MODEL);
    ir.caveats.office_ip = { params: {}, expr: { fn: 'office_network' } };
    const { dsl, warnings } = writeOpenFga(ir);
    expect(warnings).to.deep.equal(['condition office_ip: condition function office_network (spina:opaque)']);
    expect(dsl).to.contain('define viewer: [user, user with office_ip, group#member with office_ip]');
    const config = irToRebacConfig(readOpenFga(dsl));
    expect(config.namespaces.doc.relations?.viewer).to.deep.equal(['user', 'user with office_ip', 'group#member with office_ip']);
    expect(config.caveats.office_ip).to.deep.equal({ params: {}, expr: { fn: 'office_network' } });
    expect(config.problems).to.deep.equal([]);
  });
});
