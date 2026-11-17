import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { LogLevel } from '@spinajs/log';
import type { ILogEntry } from '@spinajs/log';

import { LogStore } from '../src/buffers/log-store.js';
import { StudioLogTarget } from '../src/log-target.js';

const entry = (level: LogLevel, levelName: string, extra: Record<string, unknown> = {}): ILogEntry => ({
  Level: level,
  Variables: { level: levelName, logger: 'orders', message: `a ${levelName} line`, error: undefined, ...extra },
});

describe('StudioLogTarget and LogStore', () => {
  let store: LogStore;
  let target: StudioLogTarget;

  beforeEach(() => {
    store = new LogStore(3, ['password']);
    DI.RootContainer.Cache.add(LogStore, store);
    target = new StudioLogTarget({ name: 'Studio', type: 'StudioLogTarget', enabled: true, layout: '' });
  });

  afterEach(() => DI.uncache(LogStore));

  it('keeps a line that carries a trace id, under either spelling', () => {
    target.write(entry(LogLevel.Info, 'info', { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), orderId: 7 }));
    target.write(entry(LogLevel.Info, 'info', { trace_id: 'c'.repeat(32) }));
    expect(store.forTrace('a'.repeat(32))[0]).to.deep.include({ level: 'info', logger: 'orders', spanId: 'b'.repeat(16), fields: { orderId: 7 } });
    expect(store.forTrace('c'.repeat(32))).to.have.length(1);
  });

  it('keeps warnings and errors without a trace id and drops plain info lines', () => {
    target.write(entry(LogLevel.Info, 'info'));
    target.write(entry(LogLevel.Warn, 'warn'));
    target.write(entry(LogLevel.Error, 'error', { error: new Error('boom') }));
    expect(store.query({}).map((l) => l.level)).to.deep.eq(['error', 'warn']);
    expect(store.query({})[0].fields).to.deep.eq({ error: 'Error: boom' });
  });

  it('filters by minimum level and limit, newest first, within the ring capacity', () => {
    for (const n of [1, 2, 3, 4]) target.write(entry(LogLevel.Warn, 'warn', { n }));
    expect(store.query({}).map((l) => l.fields.n)).to.deep.eq([4, 3, 2]);
    expect(store.query({ limit: 1 }).map((l) => l.fields.n)).to.deep.eq([4]);
    expect(store.query({ level: 'error' })).to.have.length(0);
  });

  it('redacts the configured names in fields', () => {
    target.write(entry(LogLevel.Error, 'error', { password: 'hunter2', orderId: 7 }));
    expect(store.query({})[0].fields).to.deep.eq({ password: '[redacted]', orderId: 7 });
  });

  it('cuts the message and string fields at 2 KiB and bounds the field data of a line', () => {
    target.write(entry(LogLevel.Error, 'error', { message: 'm'.repeat(3000), note: 'n'.repeat(3000), a: 'x'.repeat(2000), b: 'x'.repeat(2000) }));
    const [line] = store.query({});
    expect(line.message.length).to.be.below(2100);
    expect(String(line.fields.note).length).to.be.below(2100);
    expect(line.fields).to.not.have.property('b');
  });

  it('writes nothing before Studio mounted its store', () => {
    DI.uncache(LogStore);
    expect(() => target.write(entry(LogLevel.Error, 'error'))).to.not.throw();
  });
});
