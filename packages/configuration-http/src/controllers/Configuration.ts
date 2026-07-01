import { BadRequestResponse, BaseController, BasePath, Body, Get, NotFound, Ok, Param, Patch, Policy, Query } from '@spinajs/http';
import { AuthorizedPolicy, Permission, Resource } from '@spinajs/rbac-http';
import { InvalidArgument } from '@spinajs/exceptions';
import { DbConfig } from '@spinajs/configuration-db-source';
import { UpdateConfigDto } from '../dto/update-config-dto.js';
import { coerceValue } from '../validation.js';

/**
 * Serializes an entry for the api. `DbConfig.dehydrate()` emits only the declared
 * columns (honoring the model hide mechanism) with values in their canonical
 * string form ( ints as "10", booleans as "1"/"0", dates as "dd-MM-yyyy" etc. ) -
 * the same representation they round-trip through on update. Meta is taken from
 * the model where the @Json converter has already parsed it into an object.
 */
function present(entry: DbConfig) {
  const out = entry.dehydrate() as Record<string, unknown>;
  out.Meta = entry.Meta ?? null;
  return out;
}

/**
 * HTTP api for database stored configuration values.
 *
 * Exposes read and update operations over the `configuration` table managed by
 * `@spinajs/configuration-db-source`. Entries themselves are created by code
 * that exposes config options ( `expose: true` ), so this api intentionally does
 * NOT allow creating or deleting arbitrary entries - only tuning their values.
 *
 * Writes are persisted to the database only. The running application picks up
 * the change through the db-source watch poll, and only for entries with
 * `Watch = true`.
 *
 * @tags Configuration
 */
@BasePath('configuration')
@Policy(AuthorizedPolicy)
@Resource('configuration')
export class ConfigurationController extends BaseController {
  /**
   * List configuration entries
   * Returns all database stored configuration entries, optionally filtered by group.
   * @security cookieAuth
   * @param group Optional group name to filter entries by
   * @response 200 List of configuration entries
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — readAny permission required on configuration resource
   */
  @Get('/')
  @Permission(['readAny'])
  public async list(@Query() group?: string) {
    const entries = await (group ? DbConfig.where('Group', group) : DbConfig.all());
    return new Ok(entries.map((e) => present(e)));
  }

  /**
   * Get configuration entry
   * Returns a single configuration entry identified by its slug.
   * @security cookieAuth
   * @param slug Unique configuration entry slug
   * @response 200 Configuration entry
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — readAny permission required on configuration resource
   * @response 404 Configuration entry not found
   */
  @Get(':slug')
  @Permission(['readAny'])
  public async get(@Param() slug: string) {
    const entry = await DbConfig.where('Slug', slug).first();
    if (!entry) {
      return new NotFound(`configuration entry "${slug}" not found`);
    }

    return new Ok(present(entry));
  }

  /**
   * Update configuration entry value
   * Updates the value ( and optionally default/watch flag ) of an existing entry.
   * The incoming value is validated against the entry `Type` and `Meta` constraints.
   * Structural fields ( slug, group, type ) cannot be changed through this api.
   * @security cookieAuth
   * @param slug Unique configuration entry slug
   * @response 200 Updated configuration entry
   * @response 400 Invalid value for the entry type or constraints
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — updateAny permission required on configuration resource
   * @response 404 Configuration entry not found
   */
  @Patch(':slug')
  @Permission(['updateAny'])
  public async update(@Param() slug: string, @Body() data: UpdateConfigDto) {
    const entry = await DbConfig.where('Slug', slug).first();
    if (!entry) {
      return new NotFound(`configuration entry "${slug}" not found`);
    }

    // entry.Meta is already an object here ( parsed by the @Json converter on load )
    const meta = entry.Meta;

    // validate & coerce into the typed representation, then serialize to the db
    // string form. model.update() persists via toSql (not the custom dehydrate),
    // so we assign the already serialized value before saving.
    try {
      entry.Value = coerceValue(entry.Type, meta, data.Value);
      if (data.Default !== undefined) {
        entry.Default = coerceValue(entry.Type, meta, data.Default);
      }
    } catch (err) {
      if (err instanceof InvalidArgument) {
        return new BadRequestResponse({ error: { message: err.message } });
      }
      throw err;
    }

    const serialized = entry.dehydrate();
    entry.Value = serialized.Value;
    if (data.Default !== undefined) {
      entry.Default = serialized.Default;
    }

    if (data.Watch !== undefined) {
      entry.Watch = data.Watch;
    }

    await entry.update();

    return new Ok(present(entry));
  }
}
