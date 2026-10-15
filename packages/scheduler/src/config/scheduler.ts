import { join, normalize, resolve } from 'path';

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return [
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'scheduler', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),
    // one up, for when the process runs from an app or build folder
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), '../', 'node_modules', '@spinajs', 'scheduler', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),
  ];
}

const scheduler = {
  system: {
    dirs: {
      cli: [...dir('cli')],
      // Apps append their schedule folders; the files are imported so their @Schedule decorators run.
      schedules: [] as string[],
    },
  },
  scheduler: {
    enabled: true,
    tick: 1000,
    leaseTtl: 60000,
    shutdownGrace: 30000,
    progressFlush: 1000,
    runLogLimit: 1000,
    maxStepResultBytes: 65536,
    retention: { enabled: true, schedule: '30 3 * * *', runs: '30d', logs: '7d', errors: '90d' },
    events: { pollInterval: 1000 },
    cli: {},
    schedules: [] as unknown[],
  },
};

export default scheduler;
