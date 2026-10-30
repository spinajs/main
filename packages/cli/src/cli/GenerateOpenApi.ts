import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log-common';
import { CliCommand, Command, Option } from '../index.js';

interface GenerateOpenApiOptions {
  manifest: string;
  out: string;
  title?: string;
  docVersion: string;
  serverUrl?: string;
  basePath?: string;
  routePrefix?: string;
}

@Command('generate:openapi', 'Generates an OpenAPI 3.1 document from an application manifest')
@Option('-m, --manifest <path>', false, 'application manifest file', 'app.manifest.json')
@Option('-o, --out <path>', false, 'output file', 'openapi.json')
@Option('--title <title>', false, 'document title, defaults to the application name')
@Option('--doc-version <version>', false, 'document version', '1.0.0')
@Option('--server-url <url>', false, 'server url, e.g. http://localhost:4557')
@Option('--base-path <path>', false, 'literal path prefix, e.g. where a proxy mounts the app')
@Option('--route-prefix <prefix>', false, 'http.controllers.route.prefix of the app, defaults to the configured value')
export class GenerateOpenApi extends CliCommand {
  @Logger('cli')
  protected Log: Log;

  @Config('http.controllers.route.prefix', { defaultValue: '' })
  protected RoutePrefix: string;

  public async execute(options: GenerateOpenApiOptions): Promise<void> {
    // Loaded lazily: @spinajs/openapi is an optional peer, command discovery must not need it.
    const { readManifest } = await import('@spinajs/manifest');
    const { manifestToOpenApi } = await import('@spinajs/openapi').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ERR_MODULE_NOT_FOUND') throw new Error('install @spinajs/openapi to use generate:openapi', { cause: err });
      throw err;
    });

    const manifest = await readManifest(options.manifest);
    const doc = manifestToOpenApi(manifest, {
      title: options.title ?? manifest.app.name,
      version: options.docVersion,
      servers: options.serverUrl ? [{ url: options.serverUrl }] : undefined,
      basePath: options.basePath,
      routePrefix: options.routePrefix ?? this.RoutePrefix,
    });

    const out = resolve(options.out);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, JSON.stringify(doc, null, 2));
    this.Log.info(`OpenAPI document written to ${out}`);
  }
}
