const queue = {
  queue: {
    // by default, all messages are sent to black hole
    // becouse some modules use queues to pass events eg. user login
    // but not always in project we want to use queue or have queue server
    default: 'black-hole',
    connections: [
      {
        name: 'black-hole',
        service: 'BlackHoleQueueClient',
      },
    ],

    // Periodic cleanup of tracked jobs ( queue_jobs rows ). The `service` selects the
    // JobRetentionService implementation; swap it to plug in a custom purge strategy.
    // Disabled by default - set `enabled: true` and a `maxAge` ( ms ) to opt in.
    retention: {
      service: 'DefaultJobRetentionService',
      enabled: false,
      interval: 60 * 60 * 1000, // how often ( ms ) to run the purge
      // maxAge: 7 * 24 * 60 * 60 * 1000, // delete terminal jobs older than this ( ms )
      // statuses: ['success', 'error', 'dead'], // which statuses to purge
    },

    // Throttle job progress persistence so a chatty job doesn't write to the DB on every
    // callback. A non-final, meta-less progress update is skipped unless it moved at least
    // `minDelta` % or `minInterval` ms have passed since the last persisted write.
    progress: {
      minDelta: 5, // minimum progress delta ( % ) between throttled writes
      minInterval: 1000, // minimum time ( ms ) between throttled writes
    },
  },
};

export default queue;
