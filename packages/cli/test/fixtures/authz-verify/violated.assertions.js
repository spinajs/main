import { defineAssertions } from '@spinajs/authz-verify';

export default defineAssertions(({ never }) => [never({ holder: 'public', permission: 'folder:read' })]);
