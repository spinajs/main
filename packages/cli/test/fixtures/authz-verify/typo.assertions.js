import { defineAssertions } from '@spinajs/authz-verify';

export default defineAssertions(({ implies, never }) => [implies('folder:update', 'folder:read'), never({ holder: 'public', permission: 'folder:updaet' }), never({ holder: 'folder#viewr', permission: 'folder:update' })]);
