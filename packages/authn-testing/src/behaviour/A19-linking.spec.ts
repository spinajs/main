import { defineRule } from './types.js';
import type { AuthnRule } from './types.js';

export const A19: AuthnRule = defineRule('A19', 'one identity, many links, unique subjects, guarded changes', []);
