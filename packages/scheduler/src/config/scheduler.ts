import { join, normalize, resolve } from 'path';

function dir(path: string) {
  return [
    resolve(
      normalize(
        join(
          process.env.WORKSPACE_ROOT_PATH ?? process.cwd(),
          'node_modules',
          '@spinajs',
          'scheduler',
          'lib',
          path,
        ),
      ),
    ),
    // one up, for when the process runs from an app or build folder
    resolve(
      normalize(
        join(
          process.env.WORKSPACE_ROOT_PATH ?? process.cwd(),
          '../',
          'node_modules',
          '@spinajs',
          'scheduler',
          'lib',
          path,
        ),
      ),
    ),
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
  // Scheduler events go nowhere until an app routes them to a real connection.
  queue: {
    routing: {
      ScheduleRunStarted: { connection: 'scheduler-empty-queue' },
      ScheduleRunSucceeded: { connection: 'scheduler-empty-queue' },
      ScheduleRunFailed: { connection: 'scheduler-empty-queue' },
      ScheduleRetrying: { connection: 'scheduler-empty-queue' },
      ScheduleDead: { connection: 'scheduler-empty-queue' },
      ScheduleErrorRegressed: { connection: 'scheduler-empty-queue' },
      SchedulePausedByFailures: { connection: 'scheduler-empty-queue' },
    },
    connections: [
      {
        name: 'scheduler-empty-queue',
        service: 'BlackHoleQueueClient',
        defaultQueueChannel: 'scheduler-jobs',
        defaultTopicChannel: 'scheduler-events',
      },
    ],
  },
  scheduler: {
    enabled: true,
    tick: 1000,
    leaseTtl: 60000,
    shutdownGrace: 30000,
    progressFlush: 1000,
    runLogLimit: 1000,
    maxStepResultBytes: 65536,
    emitTimeout: '24h',
    retention: { enabled: true, schedule: '30 3 * * *', runs: '30d', logs: '7d', errors: '90d' },
    events: { pollInterval: 1000 },
    cli: {},
    schedules: [] as unknown[],
  },
};

export default scheduler;
