import { defineRule } from './types.js';
import type { AuthnRule } from './types.js';

export const A03: AuthnRule = defineRule('A03', 'passwords are hashed with argon2id at the library defaults', []);
