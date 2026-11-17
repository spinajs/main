import * as chai from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';

import * as root from '../../src/index.js';
import { CHANGE_KINDS, ChangeLog, NoChangeLog } from '../../src/contracts/changelog.js';
import { changeLog } from '../../src/host/changelog.js';
import type { ChangeEntry, ChangeKind, ChangeQuery, ChangeRecord } from '../../src/contracts/changelog.js';

const expect = chai.expect;

class RecordingChangeLog extends ChangeLog {
  readonly appended: ChangeEntry[] = [];
  covers(_kind: ChangeKind): boolean {
    return true;
  }
  track(_kind: ChangeKind): void {}
  async append(entries: readonly ChangeEntry[]): Promise<void> {
    this.appended.push(...entries);
  }
  async since(_seq: number, _q?: ChangeQuery): Promise<readonly ChangeRecord[]> {
    return [];
  }
  async until(_at: Date, _q?: ChangeQuery): Promise<readonly ChangeRecord[]> {
    return [];
  }
  async afterInstant(_at: Date, _q?: ChangeQuery): Promise<readonly ChangeRecord[]> {
    return [];
  }
  async latest(_kind: ChangeKind, _keys: readonly string[], _at?: Date): Promise<ReadonlyMap<string, ChangeRecord>> {
    return new Map();
  }
  async coveredSince(_kind: ChangeKind): Promise<Date | undefined> {
    return undefined;
  }
  async lost(_kind: ChangeKind): Promise<void> {}
}

describe('ChangeLog contract', () => {
  afterEach(() => {
    DI.unregister(ChangeLog, RecordingChangeLog);
    DI.uncache(ChangeLog);
    DI.uncache(RecordingChangeLog);
  });

  it('names the seven kinds of authz state', () => {
    expect(CHANGE_KINDS).to.deep.eq(['tuple', 'assignment', 'membership', 'rule', 'policy', 'attribute', 'column']);
    expect(Object.isFrozen(CHANGE_KINDS)).to.eq(true);
  });

  it('is exported from the package root', () => {
    expect(root.ChangeLog).to.eq(ChangeLog);
    expect(root.changeLog).to.eq(changeLog);
  });

  it('NoChangeLog covers nothing, keeps nothing and answers empty', async () => {
    const log = new NoChangeLog();
    log.track('tuple');
    await log.append([{ kind: 'tuple', op: 'add', key: 'k' }]);

    for (const kind of CHANGE_KINDS) expect(log.covers(kind)).to.eq(false);
    expect(await log.since(0)).to.deep.eq([]);
    expect(await log.until(new Date())).to.deep.eq([]);
    expect(await log.afterInstant(new Date(0))).to.deep.eq([]);
    expect((await log.latest('tuple', ['k'])).size).to.eq(0);
    expect(await log.coveredSince('tuple')).to.eq(undefined);
    await log.lost('column', 'doc', 'test');
    expect(await log.coveredSince('column', 'doc')).to.eq(undefined);
  });

  it('changeLog() answers a NoChangeLog when no ChangeLog is registered', () => {
    expect(changeLog()).to.be.instanceOf(NoChangeLog);
    expect(changeLog()).to.eq(changeLog());
  });

  it('changeLog() answers the registered ChangeLog, one instance', () => {
    DI.register(RecordingChangeLog).as(ChangeLog);

    const log = changeLog();
    expect(log).to.be.instanceOf(RecordingChangeLog);
    expect(changeLog()).to.eq(log);
  });

  it('changeLog(container) resolves in that container', () => {
    const child = DI.child();
    child.register(RecordingChangeLog).as(ChangeLog);

    expect(changeLog(child)).to.be.instanceOf(RecordingChangeLog);
    expect(changeLog()).to.be.instanceOf(NoChangeLog);
  });
});
