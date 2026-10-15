import { expect } from 'chai';
import { defineSchedule, getBuiltinDeclarations, getScheduleDeclarations, registerBuiltinSchedule, Schedule, ScheduledTask, SCHEDULER_DEFAULTS, undefineSchedule } from '../src/index.js';

@Schedule('decorated-sample', { manual: true })
class DecoratedSample extends ScheduledTask {}

class Plain extends ScheduledTask {}

describe('@Schedule declarations', () => {
  after(() => undefineSchedule('decorated-sample'));

  it('records decorated classes', () => {
    const d = getScheduleDeclarations().find((x) => x.name === 'decorated-sample');
    expect(d?.target).to.eq(DecoratedSample);
    expect(d?.options).to.deep.eq({ manual: true });
  });

  it('defines and removes declarations imperatively, keeping duplicates for validation', () => {
    defineSchedule(Plain, 'dup', { every: '1m' });
    defineSchedule(Plain, 'dup', { every: '2m' });
    expect(getScheduleDeclarations().filter((x) => x.name === 'dup')).to.have.length(2);
    undefineSchedule('dup');
    expect(getScheduleDeclarations().filter((x) => x.name === 'dup')).to.have.length(0);
  });

  it('builds builtin declarations from config', () => {
    registerBuiltinSchedule((cfg) => (cfg.retention.enabled ? { name: 'builtin-test', options: { cron: cfg.retention.schedule }, target: Plain, source: 'builtin' } : null));
    expect(getBuiltinDeclarations(SCHEDULER_DEFAULTS).map((d) => d.name)).to.include('builtin-test');
    expect(getBuiltinDeclarations({ ...SCHEDULER_DEFAULTS, retention: { ...SCHEDULER_DEFAULTS.retention, enabled: false } }).map((d) => d.name)).to.not.include('builtin-test');
  });
});
