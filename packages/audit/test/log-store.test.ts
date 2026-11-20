import * as chai from 'chai';
import 'mocha';
import type { Log } from '@spinajs/log-common';
import { LogAuditStore, trailConfig } from '../src/index.js';

const expect = chai.expect;

class RecordingLogStore extends LogAuditStore {
  readonly lines: { level: string; fields: unknown }[] = [];

  protected log(): Pick<Log, 'info' | 'warn'> {
    const push =
      (level: string) =>
      (fields: unknown): void => {
        this.lines.push({ level, fields });
      };
    return { info: push('info'), warn: push('warn') };
  }
}

describe('LogAuditStore', () => {
  it('writes one line per event, a warning for a failure, and cannot be read', async () => {
    const store = new RecordingLogStore();
    const at = new Date('2026-11-16T10:00:00.000Z');
    await store.append({
      trail: trailConfig('security'),
      events: [
        { id: 'e1', at, kind: 'security', action: 'login', outcome: 'ok', actor: 'h1', data: { strategy: 'local' } },
        { id: 'e2', at, kind: 'security', action: 'login', outcome: 'failed', actor: 'h1', subject: { type: 'user', id: 'u1' }, data: {} },
      ],
    });

    expect(store.lines.map((l) => l.level)).to.deep.eq(['info', 'warn']);
    expect(store.lines[0].fields).to.include({ trail: 'security', id: 'e1', kind: 'security', action: 'login', outcome: 'ok', at: '2026-11-16T10:00:00.000Z', actor: 'h1', data: '{"strategy":"local"}' });
    expect(store.lines[1].fields).to.include({ subject: 'user:u1' });
    expect(await store.reader()).to.eq(undefined);
  });
});
