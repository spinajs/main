import { Test } from './Test.js';
import { Model } from '@spinajs/orm';

/**
 * Same table as `Test`, marker subclass used to prove `@FromModel({ model })` resolves
 * through the DI-provided model class instead of the parameter's reflected type.
 */
@Model('test')
export class Test5 extends Test {}
