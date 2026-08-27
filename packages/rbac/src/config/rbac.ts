import { join, normalize, resolve } from 'path';

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return [
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'rbac', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),

    // one up if we run from app or build folder
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), '../', 'node_modules', '@spinajs', 'rbac', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),
  ];
}



const rbac = {
  system: {
    dirs: {
      cli: [...dir('cli')],
    },
  },
  queue: {
    routing: {
      NewUser: { connection: 'rbac-user-empty-queue' },
      UserActivated: { connection: 'rbac-user-empty-queue' },
      UserBanned: { connection: 'rbac-user-empty-queue' },
      UserDeactivated: { connection: 'rbac-user-empty-queue' },
      UserDeleted: { connection: 'rbac-user-empty-queue' },
      UserLogged: { connection: 'rbac-user-empty-queue' },
      UserPropertyChanged: { connection: 'rbac-user-empty-queue' },
      UserUnbanned: { connection: 'rbac-user-empty-queue' },
      UserPasswordChanged: { connection: 'rbac-user-empty-queue' },
      UserPasswordChangeRequest: { connection: 'rbac-user-empty-queue' },
      UserRoleGranted: { connection: 'rbac-user-empty-queue' },
      UserRoleRevoked: { connection: 'rbac-user-empty-queue' },
      UserImpersonationStarted: { connection: 'rbac-user-empty-queue' },
      UserImpersonationEnded: { connection: 'rbac-user-empty-queue' },
    },

    // by default all events from rbac module are routed to rbac-user-empty-queue
    // and is using empty sink ( no events are sent )
    connections: [
      {
        name: 'rbac-user-empty-queue',
        service: 'BlackHoleQueueClient',
        defaultQueueChannel: 'rbac-jobs',
        defaultTopicChannel: 'rbac-events',
      },
    ],
  },
  rbac: {
    enableGuestAccount: false,

    email: {
      connection: 'rbac-email-connection',

      changePassword: {
        enabled: true,
        template: './user-change-password-template.pug',
        subject: 'Password change request',
      },

      // when user is created & activated should he receive email
      created: {
        enabled: true,
        template: './user-creation-email-template.pug',
        subject: 'Please confirm your email',
      },

      banned: {
        enabled: true,
        template: './user-banned-email-template.pug',
        subject: 'Account banned',
      },

      unbanned: {
        enabled: true,
        template: './user-unbanned-email-template.pug',
        subject: 'Account unbanned',
      },

      deleted: {
        enabled: true,
        template: './user-deleted-email-template.pug',
        subject: 'Account deleted',
      },

      deactivated: {
        enabled: true,
        template: './user-deactivated-email-template.pug',
        subject: 'Account deactivated',
      },

      passwordExpired: {
        enabled: true,
        template: './user-password-expired-template.pug',
        subject: 'Password expired',
      },

      passwordWillExpire: {
        enabled: true,
        template: './user-password-will-expire-soon.pug',
        subject: 'Your password will expire soon',
      },

      activated: {
        enabled: true,
        template: './user-activated-email-template.pug',
        subject: 'Account activated',
      },

      // when user is created, should he confirm email
      // if false, user is acvite at creation,
      // when true, first, user will be sent confirmation email
      confirm: {
        enabled: true,
        template: './user-confirmation-email-template.pug',
        subject: 'Account created',
      },
    },
    // default roles to manage users & guest account
    roles: [
      {
        Name: 'Admin',
        Description: 'Administrator',
      },
      {
        Name: 'User',
        Description: 'Simple account without any privlidge',
      },
    ],
    grants: {
      guest: {
        'UserBase':{
          'read:own': ['*'],
        }
      },
      
      // system user can do anything that admin can and more
      system: {
        $extend: ['admin'],
      },

      'admin.users': {
        users: {
          'create:any': ['*'],
          'read:any': ['*'],
          'update:any': ['*'],
          'delete:any': ['*'],
        },
        'user.metadata': {
          'create:any': ['*'],
          'read:any': ['*'],
          'update:any': ['*'],
          'delete:any': ['*'],
        }
      },
      user: {
        'user': {
          'read:own': ['Email', 'Login'],
          'update:own': ['Email', 'Login', 'Password'],
        },
        'user.metadata': {
          'create:own': ['*'],
          'read:own': ['*'],
          'update:own': ['*'],
          'delete:own': ['*'],
        }
      },
      admin: {
        $extend: ['admin.users'],
      },
    },
    defaultRole: 'guest',
    auth: {
      service: 'SimpleDbAuthProvider',
    },
    password: {
      service: 'BasicPasswordProvider',

      /**
       * How auto-generated passwords are built. Separate from `validation.rule`
       * on purpose: the rule is a JSON schema describing what a HUMAN may
       * choose, and a schema is not something you can generate from. This says
       * which characters to draw and how many.
       *
       * `characters` entries are concatenated into one pool, so both
       * `['abc', 'def']` and `['a', 'b', 'c']` mean the same thing.
       *
       * Keep this pool able to satisfy `validation.rule` — the default rule
       * demands a digit, so the default pool contains digits. `generate()`
       * asserts the result against the rule and throws if the two disagree.
       */
      generator: {
        length: 16,
        characters: ['abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '0123456789'],
      },

      validation: {
        service: 'BasicPasswordValidationProvider',
        rule: {
          // UNCOMMENT ONE OF BELOW OR MODIFY
          // VALIDATION RULE IS JSON SCHEMA

          // Minimum eight characters, at least one letter and one number
          pattern: '^(?=.*\\d).{8,}$',

          // Minimum eight characters, at least one letter, one number and one special character:
          // pattern: '^(?=.*[A-Za-z])(?=.*\d)(?=.*[@$!%*#?&])[A-Za-z\d@$!%*#?&]{8,}$',

          // Minimum eight characters, at least one uppercase letter, one lowercase letter and one number
          // pattern: '^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[a-zA-Z\d]{8,}$',

          // Minimum eight characters, at least one uppercase letter, one lowercase letter and one number
          // pattern: '^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$',

          type: 'string',
        },
      },

      /**
       * Should password expire after some time ?
       */

      expiration: {
        enabled: true,

        // in seconds
        passwordExpirationTime: 31 * 24 * 60 * 60,
      },

      /**
       * How long we should wait to reset password ( after this time reset token is invalid )
       */
      passwordResetWaitTime: 60 * 60,

      /**
       * The application page that redeems a reset token, e.g.
       * `https://app.example.com/password-reset`.
       *
       * `passwordChangeRequest` appends `token` and `email` to it and hands the
       * result to the `changePassword` template as `ResetUrl`; that page sends
       * both back to `POST /auth/password/reset`. Empty by default because only
       * the application knows its own address — a template then renders without
       * a link rather than with one pointing nowhere.
       */
      resetUrl: '',

      /**
       * Consecutive failed logins that lock the account. 0 disables throttling.
       */
      blockAfterAttempts: 5,

      /**
       * How long the account stays locked once `blockAfterAttempts` is hit,
       * in seconds.
       */
      lockoutTime: 15 * 60,
    },
    user: {
      profile: "BasicProfileProvider"
    },
    session: {
      service: 'MemorySessionStore',

      /**
       * Session expiration strategy. Selected by `service` (one of
       * AbsoluteExpiration | SlidingExpiration | SlidingCappedExpiration).
       * Each strategy reads only the keys it uses. Units are MINUTES.
       */
      expiration: {
        service: 'SlidingCappedExpiration',

        // idle timeout — OWASP puts a low-risk application at 15-30 minutes
        ttl: 30, // minutes

        // hard ceiling on a single session's life, regardless of activity
        maxLifetime: 480, // minutes (SlidingCappedExpiration only)
      },

      /**
       * Session cookie. Passed through to express, EXCEPT:
       *  - `httpOnly` is forced on and cannot be configured away,
       *  - `secure` and `sameSite` default to `true` / `'strict'`,
       *  - `name` sets the cookie name ( default `ssid` ),
       *  - `hostPrefix: true` emits it as `__Host-<name>`, which additionally
       *    forces `secure`, `path: '/'` and drops `domain`.
       *
       * Local http development needs `secure: false`; everything else should be
       * left alone.
       */
      cookie: {
        /**
         * Secure everywhere except local development.
         *
         * `NODE_ENV=production` is what a deployment sets, and there the cookie
         * must never leave over plain http. Anywhere else ( a developer running
         * the app on http://localhost ) the browser would simply drop a Secure
         * cookie and nobody could log in, so it is relaxed there and only
         * there.
         *
         * An application serving https outside production should set this back
         * to `true` in its own config.
         */
        secure: process.env.NODE_ENV === 'production',
      },
    },

    /**
     * System role is used to perform internal operations on users, like password reset, email change etc.
     */
    systemRole: 'system',
    /**
         * Middleware functions for user actions.
         * Each action can have before and after middleware arrays.
         * Middleware functions receive the User and should return the User.
         * eg. beforeCreate: [(u: User) => { u.Metadata['custom:key'] = 'value'; return u; }]
         */
    actions: {
      create: {
        beforeCreate: [] as Array<Function>,
        afterCreate: [] as Array<Function>,
      },
    },



    /**
     * Column name in database where role is stored, by default is "Role", but if your user table has different column name, you can change it here
     */
    roleColumn: 'Role',

    /**
     * Role switching behavior. Users with multiple roles can switch the
     * currently active role via /auth/active-role.
     */
    roleSwitch: {
      /**
       * Roles whose activation requires the user to re-enter their password.
       * Use to gate privileged role switches (e.g. 'admin', 'system').
       */
      requirePassword: [] as string[],
    },

    /**
     * Impersonation lets a privileged user (createAny on virtual resource
     * 'user:impersonate') act as another user for the rest of the session.
     * Example admin grant:
     *   admin: { 'user:impersonate': { 'create:any': ['*'] } }
     */
    impersonation: {
      /**
       * When true, starting impersonation requires the impersonator to
       * re-enter their password as a confirmation step.
       */
      requirePassword: true,

      /**
       * Targets whose role list intersects this set cannot be impersonated.
       * 'system' is reserved for internal automation and is blocked by default.
       */
      protectedRoles: ['system'] as string[],
    },
  },
};

export default rbac;
