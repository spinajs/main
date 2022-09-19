const queue = {
  queue: {
    /**
     * always register local per-process event emitter & handler
     * it will allow to receive local events, it will accept all events
     */
    connections: [
      {
        transport: 'event-local-transport',
        channel: '*',
        name: 'local-event-emitter',
      },
    ],
  },
};

export default queue;
