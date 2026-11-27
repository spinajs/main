import { defineAssertions } from '@spinajs/authz-verify';

export default defineAssertions(({ never }) => [never({ holder: ['folder#viewer'], permission: 'folder:read' }), never({ holder: 'folder#viewr', permission: 'folder:raed' })]);
