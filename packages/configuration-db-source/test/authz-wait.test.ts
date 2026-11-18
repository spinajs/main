import { expect } from 'chai';
import { DI, IContainer } from '@spinajs/di';
import { AuthzService, SYSTEM, authz } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';

import { DbConfigSourceBotstrapper } from '../src/index.js';
import { asSystem, requireSystemPrincipal, resetSystemPrincipal, setBootWait } from '../src/system.js';

const RESOLVED = 'di.resolved.AuthzService';

interface SweepInternals {
  syncExposedOptions(container: IContainer): void;
  saveConfigOptions(v: unknown): Promise<void>;
  startWatchTimer(container: IContainer): void;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asSystemPrincipal(i: number): Promise<number> {
  return asSystem(async () => (authz().current() === SYSTEM ? i : -1));
}

/** A container holding `count` exposed options, for a sweep whose inserts and watch timer are stubbed. */
function containerWithOptions(count: number): IContainer {
  const vars = Array.from({ length: count }, (_, i) => ({ path: `waited.${i}`, options: { expose: true, exposeOptions: { type: 'string', group: 'g' } } }));
  return { get: () => vars } as unknown as IContainer;
}

describe('configuration-db-source waiting for authz', function () {
  this.timeout(10000);

  let warnings: string[];
  let consoleWarn: typeof console.warn;
  const onProcessWarning = (w: Error) => warnings.push(`${w.name}: ${w.message}`);

  beforeEach(() => {
    requireSystemPrincipal();
    warnings = [];
    consoleWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    process.on('warning', onProcessWarning);
  });

  afterEach(async () => {
    console.warn = consoleWarn;
    process.off('warning', onProcessWarning);
    setBootWait(15_000);
    resetSystemPrincipal();
    await testHost.uninstallHost();
  });

  it('eleven queries before authz resolves add one listener and print no leak warning', async () => {
    const before = DI.listenerCount(RESOLVED);

    const pending = Array.from({ length: 11 }, (_, i) => asSystemPrincipal(i));
    expect(DI.listenerCount(RESOLVED) - before, 'listeners added while authz is not booted').to.be.at.most(1);

    await testHost.installHost();
    await DI.resolve(AuthzService);

    expect(await Promise.all(pending)).to.eql(Array.from({ length: 11 }, (_, i) => i));
    expect(DI.listenerCount(RESOLVED), 'listeners left once authz resolved').to.equal(before);
    expect(warnings).to.eql([]);
  });

  it('a wait the boot timer ends leaves no listener behind', async () => {
    await testHost.installHost();
    setBootWait(50);
    const before = DI.listenerCount(RESOLVED);

    const pending = Array.from({ length: 11 }, (_, i) => asSystemPrincipal(i));
    expect(DI.listenerCount(RESOLVED) - before, 'listeners added while authz is not booted').to.be.at.most(1);

    expect(await Promise.all(pending)).to.eql(Array.from({ length: 11 }, (_, i) => i));
    expect(DI.listenerCount(RESOLVED), 'listeners left once the timer booted authz').to.equal(before);
    expect(warnings.filter((w) => w.includes('listeners added'))).to.eql([]);
  });

  it('the sweep of a guarded app inserts nothing until authz resolves', async () => {
    const bootstrapper = new DbConfigSourceBotstrapper();
    const internals = bootstrapper as unknown as SweepInternals;
    let saves = 0;
    internals.saveConfigOptions = async () => {
      saves++;
    };
    internals.startWatchTimer = () => undefined;

    internals.syncExposedOptions(containerWithOptions(11));
    await wait(30);
    expect(saves, 'inserts sent before authz resolved').to.equal(0);

    await testHost.installHost();
    await DI.resolve(AuthzService);
    await wait(30);
    expect(saves).to.equal(11);
  });
});
