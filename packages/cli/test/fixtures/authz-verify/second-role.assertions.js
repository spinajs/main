import { defineAssertions } from '@spinajs/authz-verify';

export default defineAssertions(({ never }) => [never({ holder: 'role:reader', permission: 'doc:read' })]);
