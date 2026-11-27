import { defineAssertions } from '@spinajs/authz-verify';

export default defineAssertions(({ never }) => [never({ holder: 'tenant#member', permission: 'tenant:enter' }), never({ holder: 'role:member', permission: 'tenant:enter' })]);
