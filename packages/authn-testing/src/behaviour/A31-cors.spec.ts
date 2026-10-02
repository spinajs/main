import { defineRule } from './types.js';
import type { AuthnRule } from './types.js';

export const A31: AuthnRule = defineRule('A31', 'CORS allows only listed origins', []);
