import { defineRule } from './types.js';
import type { AuthnRule } from './types.js';

export const A22: AuthnRule = defineRule('A22', "cookie-authenticated unsafe requests need the app's own origin", []);
