import { token } from './token.js';
import type { IPropertyTypeResolver } from './interfaces.js';

export const PROPERTY_TYPE_RESOLVER = token<IPropertyTypeResolver>('__property_type_resolver__', 'types of injected properties without decorator metadata');
