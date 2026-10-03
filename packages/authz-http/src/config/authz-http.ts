const authzHttp = {
  authz: {
    http: {
      /** Header-token service principals: `{ name, header, token, attributes? }`; `token` may list several for rotation. */
      services: [] as unknown[],
      /** Never registered in production (H19, B41). */
      explainRoute: { enabled: false, permission: 'authz:explain' },
      links: { query: 'link', header: 'X-Authz-Link', cookie: null as string | null },
    },
  },
};

export default authzHttp;
