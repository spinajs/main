// Runs in a fresh node process (see fatal-exit.test.ts): the mocha process sets its own exit code.
import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';

import '../../src/index.js';

const mode = process.argv[2];

const CONSOLE = { targets: [{ name: 'Console', type: 'ConsoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Console' }] };

class ProbeConfiguration extends FrameworkConfiguration {
  protected loadSources(): void {
    this.Sources = [];
  }

  protected onLoad(): unknown {
    return { logger: mode.startsWith('invalid') ? { targets: 'not-a-list' } : CONSOLE };
  }
}

async function boot(): Promise<void> {
  for (const b of await DI.resolve(Array.ofType(Bootstrapper))) {
    await b.bootstrap();
  }
  await DI.resolve(Configuration);
  process.stdout.write('__PROBE__resolved__PROBE__\n');
}

DI.setESMModuleSupport();
DI.register(ProbeConfiguration).as(Configuration);

if (mode === 'invalid-unawaited') {
  // An entry that starts its boot and neither awaits nor catches it.
  void boot();
} else {
  await boot();
}

if (mode === 'throw') {
  setTimeout(() => {
    throw new Error('probe uncaught exception');
  }, 10);
  setTimeout(() => process.stdout.write('__PROBE__still-running__PROBE__\n'), 50);
}
