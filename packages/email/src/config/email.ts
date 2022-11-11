import { join, normalize, resolve } from 'path';

function dir(path: string) {
  return resolve(normalize(join(__dirname, path)));
}

const email = {
  system: {
    dirs: {
      cli: [dir('./../cli')],
      jobs: [dir('./../jobs')],
    },
  },
  email: {
    // default email queue / transport
    queue: 'email-queue',
  },
  queue: {
    routing: {
      EmailSendJob: { connection: 'queue-emails' },
      EmailSent: { connection: 'queue-emails' },
    },

    // by default we dont have queue server for sending emails
    connections: [
      {
        name: 'queue-emails',
        transport: 'BlackHoleQueueClient',
        defaultQueueChannel: 'email-jobs',
        defaultTopicChannel: 'email-events',
      },
    ],
  },
};

export default email;
