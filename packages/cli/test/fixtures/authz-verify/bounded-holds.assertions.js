import { defineAssertions } from '@spinajs/authz-verify';

export default defineAssertions(({ never }) => [never({ holder: 'role:other', permission: 'tenant:enter' }), never({ holder: 'role:other@tenant', permission: 'tenant:enter' })]);
