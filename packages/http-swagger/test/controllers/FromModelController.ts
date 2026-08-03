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
 *
 * Every route here is LEGAL under the strict path-parameter contract: a path
 * argument either carries an explicit `paramField` naming a placeholder, or its
 * own name is a placeholder. Illegal shapes must not live in this directory -
 * `test/controllers` is loaded by every suite in the package, and an illegal
 * route would make the builder throw while unrelated suites build their spec.
 * They are exercised against a directly constructed builder instead, in
 * `test/swagger-path-params-strict.test.ts`.
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
   * The argument name IS the placeholder - the only implicit binding the strict
   * resolver accepts.
   * @param id The slide loaded from the database
   */
  @Get(':id')
  public async getSlide(@FromModel() id: FromModelSlide) {
    return new Ok({ id });
  }

  /**
   * Two placeholders, each declared by an argument of its own name.
   * @param owner The account the slide belongs to
   * @param id The slide loaded from the database
   */
  @Get('scoped/:owner/slides/:id')
  public async getScopedSlide(@Param() owner: number, @FromModel() id: FromModelSlide) {
    return new Ok({ owner, id });
  }

  /**
   * paramField names the placeholder the value is read from at runtime, so the
   * argument name is free to differ from it.
   */
  @Del('tickets/:ticket')
  public async deleteTicket(@FromModel({ paramField: 'ticket' }) item: FromModelTicket) {
    return new Ok({ item });
  }

  /**
   * A placeholder no argument declares. The backend compiles with
   * `noUnusedParameters`, so a handler that never reads `:year` cannot declare an
   * argument for it - the placeholder is carried by the URL template alone and the
   * document must still describe it.
   */
  @Get('archive/:year/slides/:id')
  public async getArchivedSlide(@FromModel({ paramField: 'id' }) slide: FromModelSlide) {
    return new Ok({ slide });
  }

  /**
   * Non-default paramType - the key travels in the query string, not the path.
   */
  @Get('by-query')
  public async findSlide(@FromModel({ paramType: ParameterType.FromQuery, paramField: 'slideId' }) slide: FromModelSlide) {
    return new Ok({ slide });
  }
}
