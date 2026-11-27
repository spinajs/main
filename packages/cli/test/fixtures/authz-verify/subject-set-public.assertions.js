import { defineAssertions } from '@spinajs/authz-verify';

export default defineAssertions(({ isolated }) => [isolated('tenant', { except: ['tenant#member'] })]);
