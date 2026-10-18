const cli = {
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
