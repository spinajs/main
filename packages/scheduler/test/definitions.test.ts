import { expect } from 'chai';
import { buildDefinitions, BuildDefinitionsInput, definitionHash, ScheduledTask, ScheduleDeclaration, ScheduleValidationError } from '../src/index.js';

class Reconciler extends ScheduledTask {}
class ImportRates extends ScheduledTask {}
class NotATask {}

const decl = (name: string, options: object, target: unknown = Reconciler): ScheduleDeclaration => ({ name, options, target: target as never, source: 'decorator' });
const input = (declarations: ScheduleDeclaration[], config: BuildDefinitionsInput['config'] = []): BuildDefinitionsInput => ({
  declarations,
  config,
  tickMs: 1000,
  validateParamsSchema: (s) => ((s as { type?: string }).type === 'nonsense' ? 'unknown type' : null),
});

function problems(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    expect(err).to.be.instanceOf(ScheduleValidationError);
    return (err as ScheduleValidationError).problems;
  }
  throw new Error('expected ScheduleValidationError');
}

describe('buildDefinitions', () => {
  it('applies defaults to a decorator declaration', () => {
    const [d] = buildDefinitions(input([decl('reconciler', { every: '5m' })]));
    expect(d).to.include({ name: 'reconciler', jitterMs: 0, misfireThresholdMs: 5000, overlap: 'skip', runOn: 'leader', resumable: false, enabled: true, source: 'decorator', task: Reconciler });
    expect(d.misfire).to.deep.eq({ kind: 'run-once' });
    expect(d.retry).to.eq(undefined);
  });

  it('normalizes retry, misfire, timeout and params', () => {
    const [d] = buildDefinitions(
      input([decl('import-rates', { cron: '0 2 * * *', timezone: 'Europe/Warsaw', retry: { attempts: 3, backoff: 'exponential', delay: '1m', maxDelay: '30m' }, misfire: 'catch-up(3)', timeout: '10m', params: { type: 'object' }, resumable: true, pauseAfterFailures: 5 }, ImportRates)]),
    );
    expect(d.retry).to.deep.include({ attempts: 3, backoff: 'exponential', delayMs: 60_000, maxDelayMs: 1_800_000 });
    expect(d.misfire).to.deep.eq({ kind: 'catch-up', max: 3 });
    expect(d.timeoutMs).to.eq(600_000);
    expect(d.paramsSchema).to.deep.eq({ type: 'object' });
    expect(d.pauseAfterFailures).to.eq(5);
  });

  it('lets config override timing and keep the rest', () => {
    const [d] = buildDefinitions(input([decl('reconciler', { every: '5m', jitter: '10s' })], [{ name: 'reconciler', cron: '0 * * * *' }]));
    expect(d.spec.kind).to.eq('cron');
    expect(d.jitterMs).to.eq(10_000);
    expect(d.source).to.eq('config');
  });

  it('creates a schedule from a task class named in config', () => {
    const defs = buildDefinitions(input([decl('reconciler', { every: '5m' })], [{ name: 'reconciler-hourly', task: 'Reconciler', every: '1h' }]));
    expect(defs.map((d) => d.name)).to.deep.eq(['reconciler', 'reconciler-hourly']);
    expect(defs[1].task).to.eq(Reconciler);
  });

  it('reports every problem at once', () => {
    const p = problems(() =>
      buildDefinitions(
        input(
          [decl('dup', { every: '1m' }), decl('dup', { every: '2m' }, ImportRates), decl('bad-cron', { cron: 'nope' }), decl('bad-tz', { every: '1m', timezone: 'Nowhere/X' }), decl('bad-params', { manual: true, params: { type: 'nonsense' } }), decl('bad-misfire', { every: '1m', misfire: 'catch-up(0)' as never }), decl('not-task', { every: '1m' }, NotATask)],
          [{ name: 'ghost', every: '1m' }, { name: 'from-task', task: 'Missing', every: '1m' }],
        ),
      ),
    );
    const text = p.join('\n');
    expect(text).to.match(/duplicate schedule name 'dup'.*Reconciler.*ImportRates/);
    expect(text).to.match(/bad-cron.*cron/);
    expect(text).to.match(/bad-tz.*time zone/);
    expect(text).to.match(/bad-params.*params schema.*unknown type/);
    expect(text).to.match(/bad-misfire.*misfire/);
    expect(text).to.match(/not-task.*ScheduledTask/);
    expect(text).to.match(/ghost.*no @Schedule class/);
    expect(text).to.match(/from-task.*unknown task 'Missing'/);
  });

  it('rejects emit together with runOn all', () => {
    class Job {}
    const p = problems(() => buildDefinitions(input([decl('e', { every: '1m', runOn: 'all', emit: Job as never })])));
    expect(p.join()).to.match(/emit.*runOn/);
  });

  it('hashes definitions stably and changes the hash on timing changes', () => {
    const a = buildDefinitions(input([decl('a', { every: '5m', retry: { attempts: 2 } })]))[0];
    const b = buildDefinitions(input([decl('a', { retry: { attempts: 2 }, every: '5m' })]))[0];
    const c = buildDefinitions(input([decl('a', { every: '10m', retry: { attempts: 2 } })]))[0];
    expect(definitionHash(a)).to.eq(definitionHash(b));
    expect(definitionHash(a)).to.not.eq(definitionHash(c));
  });
});
