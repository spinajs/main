import { BaseController, BasePath, Del, Get, Ok, Param, Parameter, ParameterType, Route } from '@spinajs/http';

/**
 * Test-only equivalent of the orm / orm-http @FromModel stack.
 *
 * http-swagger has no @spinajs/orm dependency - it reads the model descriptor
 * through the global `Symbol.for('MODEL_DESCRIPTOR')`. These fixtures reproduce
 * what orm and orm-http actually store at runtime:
 *
 *  - orm stores the descriptor as metadata on the model constructor, keyed by
 *    class identity ( see FilterController for the same trick )
 *  - `PrimaryKey` is filled ONLY by the @Primary decorator. Plenty of legacy
 *    models don't have it - for those the primary key is known only from the
 *    `Columns` the driver introspected ( `PrimaryKey: true` on the column ),
 *    which is why FromModelTicket below has an empty `PrimaryKey`
 *  - orm-http's `@FromModel(opts)` is exactly
 *    `Route(Parameter('FromDbModel', null, opts))`, and `param.Name` ends up
 *    being the TypeScript ARGUMENT name, never the `:placeholder` from the URL
 */
const MODEL_DESCRIPTOR_SYMBOL = Symbol.for('MODEL_DESCRIPTOR');

/**
 * Model with an @Primary()-declared, auto increment integer key.
 */
export class FromModelSlide {}

Reflect.defineMetadata(
  MODEL_DESCRIPTOR_SYMBOL,
  {
    Name: 'FromModelSlide',
    TableName: 'slides',
    PrimaryKey: ['SlideId'],
    Columns: [
      { Name: 'SlideId', Type: 'int', PrimaryKey: true, AutoIncrement: true, Nullable: false, MaxLength: -1 },
      { Name: 'title', Type: 'varchar', PrimaryKey: false, AutoIncrement: false, Nullable: false, MaxLength: 255 },
    ],
    Relations: new Map(),
  },
  FromModelSlide,
);

/**
 * Legacy-style model: no @Primary(), so the key is only visible on the column
 * descriptor the driver filled in. Key is a string ( varchar ).
 */
export class FromModelTicket {}

Reflect.defineMetadata(
  MODEL_DESCRIPTOR_SYMBOL,
  {
    Name: 'FromModelTicket',
    TableName: 'tickets',
    PrimaryKey: [],
    Columns: [
      { Name: 'Uuid', Type: 'varchar', PrimaryKey: true, AutoIncrement: false, Nullable: false, MaxLength: 36 },
      { Name: 'subject', Type: 'varchar', PrimaryKey: false, AutoIncrement: false, Nullable: true, MaxLength: 255 },
    ],
    Relations: new Map(),
  },
  FromModelTicket,
);

/**
 * Test-only equivalent of orm-http's @FromModel decorator.
 */
function FromModel(options?: unknown) {
  return Route(Parameter('FromDbModel', null, options));
}

/**
 * Routes that load a model straight from the primary key carried by the URL.
 * @tags FromModelTests
 */
@BasePath('frommodel')
export class FromModelController extends BaseController {
  /**
   * Route whose path placeholder ( :id ) does NOT match the argument name ( slide ).
   * @param slide The slide loaded from the database
   */
  @Get(':id')
  public async getSlide(@FromModel() slide: FromModelSlide) {
    return new Ok({ slide });
  }

  /**
   * Two placeholders, one of them already spoken for by a plain @Param().
   */
  @Get('scoped/:owner/slides/:id')
  public async getScopedSlide(@Param() owner: number, @FromModel() entry: FromModelSlide) {
    return new Ok({ owner, entry });
  }

  /**
   * The argument name already matches a placeholder - but not the FIRST one, and the
   * other placeholder belongs to a @Param() whose argument is underscore-prefixed.
   */
  @Get('threads/:thread/tickets/:ticket')
  public async getThreadTicket(@Param() _thread: number, @FromModel() ticket: FromModelTicket) {
    return new Ok({ ticket });
  }

  /**
   * Underscore-prefixed @Param() next to a @FromModel() whose argument name matches
   * NO placeholder. The @Param() only claims `room` through the underscore alias, so
   * a claim pass that compares argument names verbatim leaves `room` free, hands it to
   * the @FromModel(), and then the alias renames `_room` to `room` as well - two path
   * parameters called `room` and no `seat` at all.
   */
  @Get('rooms/:room/seats/:seat')
  public async getRoomSeat(@Param() _room: number, @FromModel() item: FromModelTicket) {
    return new Ok({ item });
  }

  /**
   * paramField names the placeholder the value is read from at runtime.
   */
  @Del('tickets/:ticket')
  public async deleteTicket(@FromModel({ paramField: 'ticket' }) item: FromModelTicket) {
    return new Ok({ item });
  }

  /**
   * Non-default paramType - the key travels in the query string, not the path.
   */
  @Get('by-query')
  public async findSlide(@FromModel({ paramType: ParameterType.FromQuery, paramField: 'slideId' }) slide: FromModelSlide) {
    return new Ok({ slide });
  }
}
