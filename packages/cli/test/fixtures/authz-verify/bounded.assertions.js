import { defineAssertions } from '@spinajs/authz-verify';

export default defineAssertions(({ isolated }) => [isolated('folder')]);
