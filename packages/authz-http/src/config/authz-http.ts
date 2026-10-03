import { join, normalize, resolve } from 'path';

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'authz-http', 'lib', inCommonJs ? 'cjs' : 'mjs', path)));
}

const authzHttp = {
  system: {
    dirs: {
      controllers: [dir('controllers')],
    },
  },
  authz: {
    http: {
      /** Header-token service principals: `{ name, header, token, attributes? }`; `token` may list several for rotation. */
      services: [] as unknown[],
      /** Never registered in production (H19, B41). */
      explainRoute: { enabled: false, permission: 'authz:explain' },
      links: { query: 'link', header: 'X-Authz-Link', cookie: null as string | null },
      /** The domain GET /user/access and POST /user/access/check answer for. */
      access: { domain: 'root' },
    },
  },
};

export default authzHttp;
