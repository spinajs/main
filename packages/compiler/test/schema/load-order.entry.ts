import '../../src/schema/handlers/object.js';
import { derive } from './harness.js';

const { schema } = derive('OLiteral');
if (schema.type !== 'object') throw new Error('unexpected schema');
