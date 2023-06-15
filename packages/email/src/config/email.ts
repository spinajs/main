import { join, normalize, resolve } from 'path';

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return resolve(normalize(join(process.cwd(), 'node_modules', '@spinajs', 'email', 'lib', inCommonJs ? 'cjs' : 'mjs', path)));
}
const email = {
  system: {
    dirs: {
      cli: [dir('cli')],
      jobs: [dir('jobs')],
    },
  },
  email: {
    // default email queue / transport
    queue: 'email-queue-black-hole',
  },
  queue: {
    routing: {
      EmailSendJob: { connection: 'email-queue-black-hole' },
      EmailSent: { connection: 'email-queue-black-hole' },
    },

    // by default we dont have queue server for sending emails
    connections: [
      {
        name: 'email-queue-black-hole',
        service: 'BlackHoleQueueClient',
        defaultQueueChannel: 'email-jobs',
        defaultTopicChannel: 'email-events',
      },
    ],
  },
};

export default email;
