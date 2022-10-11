const queue = {
  queue: {
    default: 'local',
    /**
     * always register local per-process event emitter & handler
     * it will allow to send & receive local events
     */
    connections: [
      {
        transport: 'job-local-transport',
        name: 'local/job',

        // difference between job and event
        // is that job can be consumed only once by subscriber ( but have multiple subscribers to process jobs)
        // event in the other hand, are sent to all subscribers to process ( eg. to notify about something )
        // use jobs to process in background something ( eg send email ), and events to notify others about something
        // eg. user registration fires event, and other service send welcome email, another notifies administrator,
        // etc.
        type: 'job', // type job or type event
      },

      {
        transport: 'event-local-transport',
        name: 'local/event',

        // difference between job and event
        // is that job can be consumed only once by subscriber ( but have multiple subscribers to process jobs)
        // event in the other hand, are sent to all subscribers to process ( eg. to notify about something )
        // use jobs to process in background something ( eg send email ), and events to notify others about something
        // eg. user registration fires event, and other service send welcome email, another notifies administrator,
        // etc.
        type: 'event', // type job or type event
      },
    ],
  },
};

export default queue;
