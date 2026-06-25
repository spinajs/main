import { ConfigVarProtocol } from '@spinajs/configuration-common';
import { InternalLogger } from '@spinajs/internal-logger';
import { SSMClient, GetParameterCommand, GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import { Injectable, Singleton } from '@spinajs/di';
import { assignNested, createSdkLogger, DEFAULT_CACHE_TTL, extractValue, parseAwsPath, parseBoolParam, resolveFallback, TtlCache, warnUnknownParams } from './utils.js';

@Singleton()
@Injectable(ConfigVarProtocol)
export class AwsParameterStoreVarProtocol extends ConfigVarProtocol {
  protected Client!: SSMClient;
  protected cache = new TtlCache();

  get Protocol(): string {
    return 'aws-parameters://';
  }

  /**
   * Clears the resolved parameter cache. Mainly useful for tests and forced refreshes.
   */
  public clearCache(): void {
    this.cache.clear();
  }

  /**
   * Resolves a parameter from AWS Systems Manager Parameter Store.
   *
   * Supported path syntax: `aws-parameters://<name>[?withDecryption=true|false][#json.path]`
   *  - `withDecryption` - decrypt `SecureString` parameters (defaults to `true`)
   *  - `#json.path`     - extract a single key from a JSON encoded parameter (dot notation)
   *  - `?default=` / `?optional=true` - fallback value when the parameter cannot be resolved
   *
   * `StringList` parameters are returned as an array of strings.
   *
   * A specific parameter version / label can be requested through the AWS native syntax
   * by appending `:<version|label>` to the name eg. `aws-parameters://my/param:3`.
   *
   * A whole hierarchy can be expanded into a nested object with a trailing `/*` eg.
   * `aws-parameters://prod/myapp/*` returns `{ db: { host, port }, ... }` (prefix stripped).
   */
  public async getVar(path: string, configuration: any): Promise<string | number | boolean | object | undefined> {
    const cfg = (configuration ?? {}) as { aws?: { parameterStore?: Record<string, unknown> } };
    const psConfig = cfg.aws?.parameterStore ?? {};

    if (!this.Client) {
      const clientConfig = { ...psConfig };
      delete clientConfig.cacheTtl; // framework option, not an SDK client option
      this.Client = new SSMClient({
        ...clientConfig,
        logger: createSdkLogger('AwsParameterStoreVarProtocol'),
      });
    }

    const { id, params, jsonPath } = parseAwsPath(path);
    warnUnknownParams(params, ['withDecryption', 'default', 'optional'], 'AwsParameterStoreVarProtocol', id);

    // decrypt SecureString parameters by default, allow opting out via ?withDecryption=false
    const withDecryption = parseBoolParam(params, 'withDecryption', true, 'AwsParameterStoreVarProtocol');

    const ttl = typeof psConfig.cacheTtl === 'number' ? psConfig.cacheTtl : DEFAULT_CACHE_TTL;

    // trailing /* -> expand the whole hierarchy into a nested object
    if (id.endsWith('/*')) {
      const raw = id.slice(0, -2);
      const treePath = raw.startsWith('/') ? raw : `/${raw}`;
      try {
        return (await this.cache.resolve(`tree ${treePath} ${String(withDecryption)}`, ttl, () => this.fetchTree(treePath, withDecryption))) as object;
      } catch (err) {
        const fallback = resolveFallback(params, 'AwsParameterStoreVarProtocol', id, err);
        if (fallback.handled) {
          return fallback.value;
        }
        throw err;
      }
    }

    const cacheKey = `${id} ${String(withDecryption)}`;

    let value: string | string[] | undefined;
    try {
      value = (await this.cache.resolve(cacheKey, ttl, async () => {
        const command = new GetParameterCommand({
          Name: id,
          WithDecryption: withDecryption,
        });
        const response = await this.Client.send(command);
        InternalLogger.info(`Obtained config value for ${id} from AWS Parameter store`, 'Configuration');

        const raw = response.Parameter?.Value;
        // StringList parameters are comma separated -> expose them as an array
        if (response.Parameter?.Type === 'StringList' && raw !== undefined) {
          return raw.split(',');
        }
        return raw;
      })) as string | string[] | undefined;
    } catch (err) {
      // opt-in resilience via ?default= / ?optional=true, otherwise rethrow
      const fallback = resolveFallback(params, 'AwsParameterStoreVarProtocol', id, err);
      if (fallback.handled) {
        return fallback.value;
      }
      throw err;
    }

    if (Array.isArray(value)) {
      return value;
    }

    if (jsonPath) {
      return extractValue(value, jsonPath) as string | number | boolean | object | undefined;
    }

    // coalesce missing/empty values to empty string so config never keeps an undefined entry
    return value ?? '';
  }

  /**
   * Recursively fetches every parameter under `path` and folds them into a nested object,
   * stripping the shared path prefix. Handles pagination via `NextToken`.
   */
  protected async fetchTree(path: string, withDecryption: boolean): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    let nextToken: string | undefined;

    do {
      const response = await this.Client.send(
        new GetParametersByPathCommand({
          Path: path,
          Recursive: true,
          WithDecryption: withDecryption,
          NextToken: nextToken,
        }),
      );

      for (const param of response.Parameters ?? []) {
        if (!param.Name) {
          continue;
        }
        // '/prod/myapp/db/host' under '/prod/myapp' -> ['db', 'host']
        const relative = param.Name.slice(path.length).replace(/^\/+/, '');
        if (!relative) {
          continue;
        }
        assignNested(result, relative.split('/'), param.Value);
      }

      nextToken = response.NextToken;
    } while (nextToken);

    InternalLogger.info(`Obtained ${Object.keys(result).length} config value(s) for ${path}/* from AWS Parameter store`, 'Configuration');

    return result;
  }
}
