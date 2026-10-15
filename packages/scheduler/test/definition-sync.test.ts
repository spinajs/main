import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { buildDefinitions, DefinitionSync, ScheduledTask, ScheduleDeclaration, ScheduleDefinition, ScheduleModel } from '../src/index.js';
import { bootTestEnv } from './support/env.js';

class T1 extends ScheduledTask {}
const NOW = Date.parse('2026-01-05T10:02:00Z');
const defs = (...d: Array<[string, object]>): ScheduleDefinition[] =>
  buildDefinitions({ declarations: d.map(([name, options]): ScheduleDeclaration => ({ name, options, target: T1 })), config: [], tickMs: 1000, validateParamsSchema: () => null });
const row = (name: string) => ScheduleModel.where('Name', name).first();

describe('DefinitionSync', () => {
  let sync: DefinitionSync;

  beforeEach(async () => {
    await bootTestEnv();
    sync = DI.resolve(DefinitionSync);
  });

  it('inserts rows with the first occurrence after now', async () => {
    await sync.sync(defs(['every', { every: '5m' }], ['manual', { manual: true }], ['local', { every: '1m', runOn: 'all' }], ['once', { at: '2026-01-01T00:00:00Z' }], ['off', { every: '1m', enabled: false }]), NOW);
    expect((await row('every')).NextRunAt).to.eq(Date.parse('2026-01-05T10:05:00Z'));
    expect((await row('manual')).NextRunAt).to.eq(null);
    expect((await row('local')).NextRunAt).to.eq(null);
    expect((await row('once')).NextRunAt).to.eq(Date.parse('2026-01-01T00:00:00Z'));
    expect((await row('off')).NextRunAt).to.eq(null);
    expect((await row('every')).Paused).to.eq(false);
  });

  it('keeps NextRunAt on a non-timing change and resets it on a timing change', async () => {
    await sync.sync(defs(['a', { every: '5m' }]), NOW);
    const first = await row('a');
    await sync.sync(defs(['a', { every: '5m', retry: { attempts: 2 } }]), NOW + 60_000);
    const second = await row('a');
    expect(second.DefinitionHash).to.not.eq(first.DefinitionHash);
    expect(second.NextRunAt).to.eq(first.NextRunAt);
    await sync.sync(defs(['a', { every: '1h', retry: { attempts: 2 } }]), NOW + 60_000);
    expect((await row('a')).NextRunAt).to.eq(Date.parse('2026-01-05T11:00:00Z'));
  });

  it('does nothing when nothing changed', async () => {
    await sync.sync(defs(['a', { every: '5m' }]), NOW);
    await sync.sync(defs(['a', { every: '5m' }]), NOW + 120_000);
    expect((await row('a')).UpdatedAt).to.eq(NOW);
  });

  it('marks and un-marks orphans', async () => {
    await sync.sync(defs(['a', { every: '5m' }], ['b', { every: '5m' }]), NOW);
    await sync.sync(defs(['a', { every: '5m' }]), NOW);
    expect((await row('b')).Orphaned).to.eq(true);
    await sync.sync(defs(['a', { every: '5m' }], ['b', { every: '5m' }]), NOW);
    expect((await row('b')).Orphaned).to.eq(false);
  });

  it('tolerates two replicas booting at the same time', async () => {
    const d = defs(['a', { every: '5m' }]);
    await Promise.all([sync.sync(d, NOW), DI.resolve(DefinitionSync).sync(d, NOW)]);
    expect(await ScheduleModel.where('Name', 'a')).to.have.length(1);
  });
});
