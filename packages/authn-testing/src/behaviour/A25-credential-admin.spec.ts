import { defineRule } from './types.js';
import type { AuthnRule } from './types.js';

export const A25: AuthnRule = defineRule('A25', 'credential admin routes need users:credentials and the target guard', []);
