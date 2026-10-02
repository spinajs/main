import { defineRule } from './types.js';
import type { AuthnRule } from './types.js';

export const A04: AuthnRule = defineRule('A04', 'passwords are 8 to 128 characters, never trimmed, policy applied whenever set', []);
