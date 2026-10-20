import * as chai from 'chai';
import 'mocha';
import { userPrincipal } from '@spinajs/authz-testing';
import type { AuthzCommand, PrincipalRef, ResourceRef } from '@spinajs/authz';

import { AdminMembershipStore, MembershipStore, MemoryMembershipStore } from '../../src/index.js';
import type { AssignmentSubject } from '../../src/index.js';
import { HOUR, START, config, failure, installHost, instance, ok, rbacDomain, resetHost, uninstallHost } from './support.js';
import type { RbacDomain } from './support.js';

const expect = chai.expect;

const alice = userPrincipal('alice');
const DAVE: PrincipalRef = { type: 'user', id: 'dave' };
const group = (id: string): ResourceRef => ({ type: 'group', id });
const set = (id: string): AssignmentSubject => ({ set: { role: 'group.member', scope: group(id) } });
const key = (id: string) => `group:${id}#group.member`;
const at = (hours: number) => new Date(START.getTime() + hours * HOUR);

const join = (member: PrincipalRef, id: string, expiresAt?: Date): AuthzCommand => ({ kind: 'set.addMember', set: { role: 'group.member', scope: group(id) }, member, ...(expiresAt ? { expiresAt } : {}) });
const nest = (child: string, parent: string, expiresAt?: Date): AuthzCommand => ({ kind: 'assignment.grant', subject: set(child), role: 'group.member', scope: group(parent), ...(expiresAt ? { expiresAt } : {}) });

describe('subject set closure maintenance (design §4.3)', function () {
  this.timeout(20000);
  let d: RbacDomain;
  let m: MemoryMembershipStore;

  before(async () => {
    await installHost();
  });
  after(async () => {
    await uninstallHost();
  });
  beforeEach(async () => {
    await resetHost();
    m = new MemoryMembershipStore();
    d = await rbacDomain('test', {
      register: (c) => {
        c.register(instance(m)).as(MembershipStore);
        c.register(instance(m)).as(AdminMembershipStore);
      },
    });
  });
  afterEach(() => {
    config().set(['authz', 'rbac', 'maxSetDepth'], undefined);
  });

  const run = async (...commands: AuthzCommand[]) => ok(await d.admin.execute(alice, commands));
  const sets = async (keys: string[], when: Date) => (await m.setsOf(keys, when)).map((s) => s.setKey);

  it('nests three levels whatever the order of the writes', async () => {
    await run(join(DAVE, 'g3'), nest('g3', 'g2'));
    await run(nest('g2', 'g1'));
    expect(await sets(['user:dave'], START)).to.deep.equal([key('g1'), key('g2'), key('g3')]);
    expect(await m.membersOf(key('g1'), START)).to.deep.equal([key('g2'), key('g3'), 'user:dave']);
    expect((await m.rowsOf(['user:dave'])).map((r) => [r.setKey, r.depth])).to.deep.equal([
      [key('g1'), 3],
      [key('g2'), 2],
      [key('g3'), 1],
    ]);
  });

  it('expires a path at its earliest edge and a membership at its latest path', async () => {
    await run(nest('g2', 'g1'), nest('g3', 'g1', at(3)), nest('g3', 'g2', at(1)), join(DAVE, 'g3', at(2)));
    const rows = new Map((await m.rowsOf(['user:dave'])).map((r) => [r.setKey, r.expiresAt?.getTime()]));
    expect(rows).to.deep.equal(
      new Map([
        [key('g1'), at(2).getTime()],
        [key('g2'), at(1).getTime()],
        [key('g3'), at(2).getTime()],
      ]),
    );
    expect(await sets(['user:dave'], at(1.5))).to.deep.equal([key('g1'), key('g3')]);
  });

  it('setExpiry on a membership row recomputes the members below it', async () => {
    await run(join(DAVE, 'g2'), nest('g2', 'g1', at(1)));
    const [row] = (await d.assignments.find({ subject: set('g2'), at: START })).items;
    await run({ kind: 'assignment.setExpiry', id: row.id, expiresAt: at(5) });
    expect((await m.rowsOf(['user:dave'])).find((r) => r.setKey === key('g1'))?.expiresAt?.getTime()).to.eq(at(5).getTime());
  });

  it('a revoke shrinks the closure of every member below', async () => {
    await run(join(DAVE, 'g3'), nest('g3', 'g2'), nest('g2', 'g1'));
    await run({ kind: 'assignment.revokeWhere', scope: group('g2'), subject: set('g3'), role: 'group.member' });
    expect(await sets(['user:dave'], START)).to.deep.equal([key('g3')]);
    expect(await m.membersOf(key('g1'), START)).to.deep.equal([key('g2')]);
  });

  it('set.removeMember drops the member from every set above', async () => {
    await run(join(DAVE, 'g2'), nest('g2', 'g1'));
    await run({ kind: 'set.removeMember', set: { role: 'group.member', scope: group('g2') }, member: DAVE });
    expect(await sets(['user:dave'], START)).to.deep.equal([]);
  });

  it('refuses a cycle (set_cycle) and rolls the batch back', async () => {
    await run(nest('g1', 'g2'));
    expect(failure(await d.admin.execute(alice, [nest('g2', 'g1')]))).to.include({ at: 0, code: 'set_cycle' });
    expect(await sets([key('g1')], START)).to.deep.equal([key('g2')]);
    expect((await d.assignments.find({ subject: set('g2'), at: START })).total).to.eq(0);
  });

  it('refuses a nesting deeper than authz.rbac.maxSetDepth (set_too_deep)', async () => {
    config().set(['authz', 'rbac', 'maxSetDepth'], 2);
    await run(join(DAVE, 'g3'), nest('g3', 'g2'));
    expect(failure(await d.admin.execute(alice, [nest('g2', 'g1')]))).to.include({ at: 0, code: 'set_too_deep' });
  });

  it("scope.forget of a set's node drops its memberships and the members' rows through it", async () => {
    await run(join(DAVE, 'g3'), nest('g3', 'g2'), nest('g2', 'g1'));
    await run({ kind: 'scope.forget', scope: group('g2') });
    expect(await sets(['user:dave'], START)).to.deep.equal([key('g3')]);
    expect(await m.memberKeys()).to.deep.equal(['user:dave']);
  });

  it('set.addMember tags the member and the set, never the set role', async () => {
    await run(join(DAVE, 'g3'));
    expect([...d.bus.published.at(-1)!.tags].sort()).to.deep.equal([`subject:${key('g3')}`, 'subject:user:dave']);
  });

  it('tags a member whose id holds escaped characters by its raw principal key', async () => {
    const odd: PrincipalRef = { type: 'user', id: 'a#b%c' };
    await run(join(odd, 'g3'));
    expect([...d.bus.published.at(-1)!.tags].sort()).to.deep.equal([`subject:${key('g3')}`, 'subject:user:a#b%c']);
    await run({ kind: 'assignment.grant', subject: set('g3'), role: 'editor', scope: { type: 'project', id: 'p1' } });
    expect([...d.bus.published.at(-1)!.tags].sort()).to.deep.equal(['subject:group:g3', `subject:${key('g3')}`, 'subject:user:a#b%c']);
  });

  it('a nesting tags the sets that changed and the members below, not every decision', async () => {
    await run(join(DAVE, 'g3'));
    await run(nest('g3', 'g2'));
    expect([...d.bus.published.at(-1)!.tags].sort()).to.deep.equal([`subject:${key('g2')}`, 'subject:group:g3', `subject:${key('g3')}`, 'subject:user:dave'].sort());
  });

  it('removing a member tags every set it left', async () => {
    await run(join(DAVE, 'g3'), nest('g3', 'g2'), nest('g2', 'g1'));
    await run({ kind: 'set.removeMember', set: { role: 'group.member', scope: group('g3') }, member: DAVE });
    expect([...d.bus.published.at(-1)!.tags].sort()).to.deep.equal([`subject:${key('g1')}`, `subject:${key('g2')}`, `subject:${key('g3')}`, 'subject:user:dave'].sort());
  });

  it('a grant to a set tags the set and its live members', async () => {
    await run(join(DAVE, 'g3'));
    await run({ kind: 'assignment.grant', subject: set('g3'), role: 'editor', scope: { type: 'project', id: 'p1' } });
    expect([...d.bus.published.at(-1)!.tags].sort()).to.deep.equal(['subject:group:g3', `subject:${key('g3')}`, 'subject:user:dave']);
  });

  it('without an AdminMembershipStore nothing is maintained and a set grant keeps its role tag', async () => {
    await resetHost();
    const plain = await rbacDomain('plain');
    ok(await plain.admin.execute(alice, [join(DAVE, 'g3'), nest('g3', 'g2')]));
    expect(plain.bus.published.at(-1)!.tags).to.include('role:group.member');
  });
});
