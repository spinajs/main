import * as chai from 'chai';
import 'mocha';
import { DI, NewInstance } from '@spinajs/di';
import { Log, renderTemplate } from '@spinajs/log-common';
import type { AuditEvent } from '../src/index.js';
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

// Renders each line as the Log of @spinajs/log does before a target writes it.
@NewInstance()
class LineLog {
  static readonly lines: { logger: string; line: string }[] = [];

  constructor(readonly name: string) {}

  info(fields: Record<string, unknown>, template: string): void {
    LineLog.lines.push({ logger: this.name, line: renderTemplate(template, fields) });
  }

  warn(fields: Record<string, unknown>, template: string): void {
    this.info(fields, template);
  }
}

describe('LogAuditStore', () => {
  it('writes one line per event, a warning for a failure, and cannot be read', async () => {
    const store = new RecordingLogStore();
    const at = new Date('2026-11-16T10:00:00.000Z');
    await store.append({
      trail: trailConfig('security'),
      events: [
        { id: 'e1', at, kind: 'security', action: 'login', outcome: 'ok', actor: 'h1', data: { strategy: 'local', attempt: 2n } },
        { id: 'e2', at, kind: 'security', action: 'login', outcome: 'failed', actor: 'h1', subject: { type: 'user', id: 'u1' }, data: {} },
      ],
    });

    expect(store.lines.map((l) => l.level)).to.deep.eq(['info', 'warn']);
    expect(store.lines[0].fields).to.include({ trail: 'security', id: 'e1', kind: 'security', action: 'login', outcome: 'ok', at: '2026-11-16T10:00:00.000Z', actor: 'h1', data: '{"attempt":"2","strategy":"local"}' });
    expect(store.lines[1].fields).to.include({ subject: 'user:u1' });
    expect(await store.reader()).to.eq(undefined);
  });

  describe('the rendered line', () => {
    const at = new Date('2026-11-16T10:00:00.000Z');
    const event = (over: Partial<AuditEvent>): AuditEvent => ({ id: 'e1', at, kind: 'security', action: 'login', outcome: 'ok', actor: 'h1', data: {}, ...over });
    const child = DI.RootContainer.child();

    const lineOf = async (over: Partial<AuditEvent>): Promise<string> => {
      LineLog.lines.length = 0;
      await (await child.resolve(LogAuditStore)).append({ trail: trailConfig('security'), events: [event(over)] });
      expect(LineLog.lines.map((l) => l.logger)).to.deep.eq(['audit.security']);
      return LineLog.lines[0].line;
    };

    before(() => {
      child.register(LineLog).as(Log);
    });

    after(async () => {
      await child.dispose();
    });

    it('goes to the logger audit.<trail>, absent fields left out', async () => {
      expect(await lineOf({ subject: { type: 'user', id: 'u1' }, data: { n: 1 } })).to.eq('audit security security login ok id=e1 at=2026-11-16T10:00:00.000Z actor=h1 subject=user:u1 data="{\\"n\\":1}"');
    });

    it('quotes a value that is not a plain token, so it cannot forge a field or a line', async () => {
      const line = await lineOf({ action: 'x\naudit security security login ok id=forged', actor: 'a b', subject: { type: 'us er', id: 'x=y' } });
      expect(line).to.not.contain('\n');
      expect(line).to.contain('security "x\\naudit security security login ok id=forged" ok').and.contain('actor="a b"').and.contain('subject="us er:x=y"');
    });

    it('escapes Unicode line breaks, C1 controls and direction marks, also inside data', async () => {
      const marks = [0x2028, 0x2029, 0x85, 0x7f, 0x200e, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069, 0x61c, 0xfeff].map((c) => String.fromCharCode(c)).join('');
      const line = await lineOf({ actor: `a${marks}b`, data: { note: `n${marks}` } });
      for (const mark of marks) expect(line).to.not.contain(mark);
      expect(line).to.contain('actor="a\\u2028\\u2029\\u0085\\u007f\\u200e\\u200f\\u202a\\u202e\\u2066\\u2069\\u061c\\ufeffb"');
    });

    it('escapes $, so a value cannot bring a ${...} placeholder for a text layout to expand', async () => {
      const line = await lineOf({ actor: '${logger}', data: { x: '${?level}y${/level}' } });
      expect(line).to.not.contain('$');
      expect(line).to.contain('actor="\\u0024{logger}"').and.contain('\\u0024{?level}y\\u0024{/level}');
    });
  });
});
