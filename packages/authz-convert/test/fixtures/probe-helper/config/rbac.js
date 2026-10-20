import { isProd } from '../helpers/env.js';

export default { rbac: { session: { cookie: { secure: isProd } } } };
