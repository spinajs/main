import { BaseController, BasePath, Get, Ok, Parameter, Route } from '@spinajs/http';

/**
 * Test-only equivalents of orm-http's @Sort and @Include: http-swagger has no orm-http dependency, so these
 * reproduce the `IRouteParameter.Options` those decorators store ( SortRouteArgOptions, IncludeRouteArgOptions ).
 */
class SortablePet {}

function Sort(options: { sortable: string[]; default: string; order: string; field: string }) {
  return Route(Parameter('SortRouteArg', null, { model: SortablePet, ...options }));
}

function Include(relations: string[], field = 'include') {
  return Route(Parameter('IncludeRouteArg', null, { model: SortablePet, relations, field }));
}

/**
 * Sorted and populated list.
 * @tags SortIncludeTests
 */
@BasePath('sort-include')
export class SortIncludeController extends BaseController {
  /**
   * Pets sorted by a @Sortable() column, with optional relations.
   */
  @Get('pets')
  public pets(@Sort({ sortable: ['Name', 'CreatedAt'], default: 'CreatedAt', order: 'DESC', field: 'order' }) sort: unknown, @Include(['Owner', 'Tags']) include: string[]) {
    return new Ok({ sort, include });
  }
}
