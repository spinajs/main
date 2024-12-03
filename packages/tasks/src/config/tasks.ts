import { join, normalize, resolve } from 'path';

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return [
    resolve(
      normalize(join(process.cwd(), 'node_modules', '@spinajs', 'tasks', 'lib', inCommonJs ? 'cjs' : 'mjs', path)),
    ),

    // one up if we run from app or build folder
    resolve(
      normalize(
        join(process.cwd(), '../', 'node_modules', '@spinajs', 'tasks', 'lib', inCommonJs ? 'cjs' : 'mjs', path),
      ),
    ),
  ];
}

const cli = {
  system: {
    dirs: {
      cli: [...dir('tasks')],
    },
  },
  queue: {
    routing: {
      // task module events - inform when task fails or succeeds
      TaskFailed: { connection: 'task-empty-queue' },
      TaskSuccess: { connection: 'task-empty-queue' },
    },

    // by default all events from rbac module are routed to rbac-user-empty-queue
    // and is using empty sink ( no events are sent )
    connections: [
      {
        name: 'task-empty-queue',
        service: 'BlackHoleQueueClient',
        defaultQueueChannel: 'task-jobs',
        defaultTopicChannel: 'task-events',
      },
    ],
  },
};

export default cli;
