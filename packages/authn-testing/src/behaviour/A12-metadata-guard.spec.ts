import { defineRule } from './types.js';
import type { AuthnRule } from './types.js';

export const A12: AuthnRule = defineRule('A12', 'authentication state never travels through identity metadata', []);
