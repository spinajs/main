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
  },
};

export default queue;
