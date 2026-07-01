import { BadRequestResponse, BaseController, BasePath, Body, Get, Ok, Patch, Policy, Query } from '@spinajs/http';
import { AuthorizedPolicy, Permission, Resource } from '@spinajs/rbac-http';
import { Autoinject } from '@spinajs/di';
import { DataValidator } from '@spinajs/validation';
import { FromModel } from '@spinajs/orm-http';
import { DbConfig } from '@spinajs/configuration-db-source';
import { UpdateConfigDto } from '../dto/update-config-dto.js';
import { valueSchema } from '../validation.js';

/**
 * Serializes an entry for the api. `DbConfig.dehydrate()` emits only the declared
 * columns with Value / Default in their canonical stored form ( numbers as "10",
 * booleans as "true"/"false", dates / times as ISO 8601 etc. ) produced by the
 * DbConfigValueConverter, and Meta already parsed into an object by its @Json
 * converter - the same representation they round-trip through on update.
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
  @Autoinject()
  protected Validator!: DataValidator;

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
  public async get(@FromModel({ paramField: 'slug', queryField: 'Slug' }) entry: DbConfig) {
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
  public async update(@FromModel({ paramField: 'slug', queryField: 'Slug' }) entry: DbConfig, @Body() data: UpdateConfigDto) {
    // Build the value schema from the entry Type + Meta ( entry.Meta is already an
    // object here, parsed by its @Json converter on load ) and validate the
    // incoming value(s) against it. Validation can only happen here - not on the
    // request DTO - because the entry Type isn't known until after this lookup.
    const schema = valueSchema(entry.Type, entry.Meta);

    const valueError = this.validateValue(schema, 'Value', data.Value);
    if (valueError) {
      return valueError;
    }

    if (data.Default !== undefined) {
      const defaultError = this.validateValue(schema, 'Default', data.Default);
      if (defaultError) {
        return defaultError;
      }
    }

    // Assign the raw, validated value(s). The DbConfigValueConverter does all the
    // type-based coercion into the canonical stored form on update().
    entry.Value = data.Value as typeof entry.Value;
    if (data.Default !== undefined) {
      entry.Default = data.Default as typeof entry.Default;
    }

    if (data.Watch !== undefined) {
      entry.Watch = data.Watch;
    }

    await entry.update();

    return new Ok(present(entry));
  }

  /**
   * Validates a single value against the entry value schema, returning a 400
   * response on failure or `null` when it passes.
   *
   * The value is wrapped in an object ( `{ [field]: value }` ) so it is always a
   * non-null object for the validator - a bare `null` / scalar would otherwise
   * confuse `tryValidate`'s schema-vs-data overload resolution.
   */
  private validateValue(valueSchema: Record<string, unknown>, field: string, value: unknown): BadRequestResponse | null {
    const [isValid, errors] = this.Validator.tryValidate(
      { type: 'object', properties: { [field]: valueSchema }, required: [field] },
      { [field]: value },
    );

    if (isValid) {
      return null;
    }

    const message = (errors ?? []).map((e) => `${field}${e.instancePath ? e.instancePath.replace(`/${field}`, '') : ''} ${e.message ?? 'is invalid'}`.trim()).join('; ') || `invalid value for ${field}`;

    return new BadRequestResponse({ error: { message } });
  }
}
