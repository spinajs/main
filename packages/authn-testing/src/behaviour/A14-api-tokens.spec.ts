import { defineRule } from './types.js';
import type { AuthnRule } from './types.js';

export const A14: AuthnRule = defineRule('A14', 'API tokens are strong, bounded, revocable and checked on every use', []);
