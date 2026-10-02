import { join, normalize, resolve } from 'path';

function singleDir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'authn-http', 'lib', inCommonJs ? 'cjs' : 'mjs', path)));
}

function dirWithParent(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return [
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'authn-http', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),

    // one up if we run from app or build folder
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), '../', 'node_modules', '@spinajs', 'authn-http', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),
  ];
}

const authnHttp = {
  system: {
    dirs: {
      // Controllers are found by a filesystem scan, not by import.
      controllers: [singleDir('account/controllers'), ...dirWithParent('token/controllers')],
    },
  },
  rbac: {
    // NOTE: the session cookie ( `authn.session.cookie` ) is configured by
    // @spinajs/users and defaults to Secure + SameSite=Strict + HttpOnly. This
    // package used to weaken it to SameSite=Lax here, which is what let a
    // cross-site GET reach the logout route.
    password: {
      // NOTE: the password reset token's lifetime is `authn.local.reset.ttlSeconds`
      // ( seconds, defined by @spinajs/users ) — this package does not restate it.

      /**
       * Block account after invalid login attempts
       */
      blockAfterAttempts: 3,
    },
  },
};

export default authnHttp;
