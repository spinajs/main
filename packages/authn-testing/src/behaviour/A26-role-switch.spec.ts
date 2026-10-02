import { defineRule } from './types.js';
import type { AuthnRule } from './types.js';

export const A26: AuthnRule = defineRule('A26', 'role switch takes only held roles and rotates', []);
