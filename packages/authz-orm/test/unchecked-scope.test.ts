import * as chai from 'chai';
import 'mocha';

import type { HostLog, Principal } from '@spinajs/authz';
import { ModelBase } from '@spinajs/orm';
import type { IWhereBuilder } from '@spinajs/orm';

import { OrmAuthzContributor } from '../src/contributor.js';
import { AccessResource, OrmScope, OrmScopePolicy, registerAccessResource } from '../src/index.js';
import { unregisterResource } from '../src/registry.js';

const expect = chai.expect;

class NoScope extends OrmScopePolicy {
  scope(_q: IWhereBuilder<ModelBase>, _p: Principal, _op: 'read' | 'update' | 'delete'): void {}
}

const recording = () => {
  const lines: { level: string; message: string }[] = [];
  const at = (level: string) => (message: string) => void lines.push({ level, message });
  const log: HostLog = { error: at('error'), warn: at('warn'), info: at('info'), debug: at('debug') };
  return { contributor: new OrmAuthzContributor(log), lines };
};

describe('authz-orm: boot warning for an @OrmScope on an unchecked model', () => {
  const made: Function[] = [];
  const track = <T extends Function>(c: T): T => {
    made.push(c);
    return c;
  };

  afterEach(() => {
    for (const c of made.splice(0)) unregisterResource(c);
  });

  it('warns once, naming the model, the relation and the policy', async () => {
    class UncheckedLoose extends ModelBase {}
    @OrmScope(UncheckedLoose as never, 'pool')
    class UncheckedLoosePolicy extends NoScope {}

    const { contributor, lines } = recording();
    await contributor.contribute();
    await contributor.contribute();

    const mine = lines.filter((l) => l.message.includes('UncheckedLoose'));
    expect(mine).to.have.length(1);
    expect(mine[0]!.level).to.equal('warn');
    expect(mine[0]!.message).to.equal("authz-orm: @OrmScope(UncheckedLoose, 'pool') names UncheckedLoosePolicy, which is never applied: UncheckedLoose has no @AccessResource, so its queries are not checked");
    void UncheckedLoosePolicy;
  });

  it('is silent for an @AccessResource model', async () => {
    @AccessResource('unchecked-ok')
    class UncheckedChecked extends ModelBase {}
    track(UncheckedChecked);
    @OrmScope(UncheckedChecked as never, 'pool')
    class UncheckedCheckedPolicy extends NoScope {}
    void UncheckedCheckedPolicy;

    const { contributor, lines } = recording();
    await contributor.contribute();

    expect(lines.filter((l) => l.message.includes('UncheckedCheckedPolicy'))).to.deep.equal([]);
  });

  it('is silent for a base class of an @AccessResource model', async () => {
    class UncheckedBase extends ModelBase {}
    @OrmScope(UncheckedBase as never, 'pool')
    class UncheckedBasePolicy extends NoScope {}
    void UncheckedBasePolicy;
    @AccessResource('unchecked-sub')
    class UncheckedSub extends UncheckedBase {}
    track(UncheckedSub);

    const { contributor, lines } = recording();
    await contributor.contribute();

    expect(lines.filter((l) => l.message.includes('UncheckedBasePolicy'))).to.deep.equal([]);
  });

  it('is silent for a model registered late through registerAccessResource', async () => {
    class UncheckedLate extends ModelBase {}
    @OrmScope(UncheckedLate as never, 'pool')
    class UncheckedLatePolicy extends NoScope {}
    void UncheckedLatePolicy;
    registerAccessResource(UncheckedLate as never, 'unchecked-late');
    track(UncheckedLate);

    const { contributor, lines } = recording();
    await contributor.contribute();

    expect(lines.filter((l) => l.message.includes('UncheckedLatePolicy'))).to.deep.equal([]);
  });
});
