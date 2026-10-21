import { join, normalize, resolve } from 'path';

function lib(...path: string[]) {
  return join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'email', 'lib', ...path);
}

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return [
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'email', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),

    // one up if we run from app or build folder
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(),'../','node_modules', '@spinajs', 'email', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),
  ];
}

const email = {
  system: {
    dirs: {
      cli: [...dir('cli')],
      jobs: [...dir('jobs')],
    },
  },
  email: {
    /**
     * Default email template filesystem
     * FS must be set in configuration on server/app that sends emails
     */
    templateFs: "email-templates",

    /**
     * Default queue-level retry count for deferred emails.
     */
    retry: {
      count: 3,
    },

    /**
     * true: send() reads attachments through their filesystems as the sending principal, before the transport.
     * false: the transport reads them.
     */
    attachments: {
      check: true,
    },

    /**
     * Authn mails ( EmailPasswordMailer ). `connection` defaults to `email.defaultConnection`, `appName` to `app.name`.
     * Each `template` is an `.mjml` file: a path in `email.templateFs` or `{ file, fs }`.
     */
    password: {
      reset: { subject: 'Reset your password', template: { file: 'authn/reset.mjml', fs: 'email-builtin-templates' } },
      invite: { subject: 'Set up your account', template: { file: 'authn/invite.mjml', fs: 'email-builtin-templates' } },
    },
  },
  fs: {
    providers: [
      {
        service: 'fsNative',
        name: 'email-builtin-templates',
        basePath: lib('templates'),
      },
    ],
  },
  queue: {
    routing: {
      EmailSend: { connection: 'email-queue-black-hole' },
      EmailSent: { connection: 'email-queue-black-hole' },
      EmailSendFailed: { connection: 'email-queue-black-hole' },
    },

    // by default we dont have queue server for sending emails
    connections: [
      {
        name: 'email-queue-black-hole',
        service: 'BlackHoleQueueClient',
        defaultQueueChannel: 'email-jobs',
        defaultTopicChannel: 'email-events',
        defaultQueueDeadLetterChannel: 'email-jobs-dlq',
      },
    ],
  },
};

export default email;
