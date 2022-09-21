const queue = {
  queue: {
    default: 'local',
    /**
     * always register local per-process event emitter & handler
     * it will allow to send & receive local events
     */
    connections: [
      {
        transport: 'event-local-transport',
        name: 'local',
      },
    ],
  },
};

export default queue;
