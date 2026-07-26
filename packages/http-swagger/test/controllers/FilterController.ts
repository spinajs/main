import { BaseController, BasePath, Get, Ok, Parameter, Route } from '@spinajs/http';

/**
 * Test-only equivalent of the orm / orm-http filter stack.
 *
 * http-swagger deliberately has no @spinajs/orm dependency - it reads the model
 * descriptor through the global `Symbol.for('MODEL_DESCRIPTOR')` instead. These
 * fixtures reproduce what orm and orm-http actually store, so the extraction
 * path can be exercised without pulling either package into this suite:
 *
 *  - orm's `getInheritedDescriptor` stores the descriptor as OWN metadata on the
 *    model constructor, keyed by class identity ( it used to be a container
 *    keyed by class name - `{ [class.name]: descriptor }` - which is why this
 *    fixture matters )
 *  - orm-http's `@Filterable` fills `FilterableColumns` on that descriptor
 *  - orm-http's `@Filter(Model)` is exactly `Route(Parameter('FilterModelRouteArg', null, Model))`
 */
const MODEL_DESCRIPTOR_SYMBOL = Symbol.for('MODEL_DESCRIPTOR');

/**
 * Stand-in for an orm model. Only the fields http-swagger reads are filled in.
 */
export class FilterablePet {}

Reflect.defineMetadata(
  MODEL_DESCRIPTOR_SYMBOL,
  {
    Name: 'FilterablePet',
    TableName: 'pets',
    Columns: [],
    FilterableColumns: new Map<string, { operators: string[] }>([
      ['name', { operators: ['eq', 'like'] }],
      ['age', { operators: ['gt', 'lt', 'eq'] }],
    ]),
  },
  FilterablePet,
);

/**
 * Test-only equivalent of orm-http's @Filter decorator.
 */
function Filter(model: unknown) {
  return Route(Parameter('FilterModelRouteArg', null, model));
}

/**
 * Demonstrates the JSON filter envelope built from an orm model's filterable columns.
 * @tags FilterTests
 */
@BasePath('filter')
export class FilterController extends BaseController {
  /**
   * Route whose filter envelope is derived from FilterablePet's @Filterable columns.
   */
  @Get('pets')
  public async pets(@Filter(FilterablePet) filter: unknown) {
    return new Ok({ filter });
  }
}
