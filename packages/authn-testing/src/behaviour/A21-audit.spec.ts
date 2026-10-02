import { defineRule } from './types.js';
import type { AuthnRule } from './types.js';

export const A21: AuthnRule = defineRule('A21', 'every event reaches every sink and carries no secret', []);
