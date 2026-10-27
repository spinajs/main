import { writeFile } from 'node:fs/promises';
import { manifestToAsyncApi } from '@spinajs/asyncapi';
import { readManifest } from '@spinajs/manifest';
import { Log, Logger } from '@spinajs/log-common';
import { CliCommand, Command, Option } from '../index.js';

interface GenerateAsyncApiOptions {
  manifest: string;
  out: string;
  title?: string;
  docVersion: string;
  serverUrl?: string;
}

@Command('generate:asyncapi', 'Generates an AsyncAPI 3.0 document from an application manifest')
@Option('-m, --manifest <path>', false, 'application manifest file', 'app.manifest.json')
@Option('-o, --out <path>', false, 'output file', 'asyncapi.json')
@Option('--title <title>', false, 'document title, defaults to the application name')
@Option('--doc-version <version>', false, 'document version', '1.0.0')
@Option('--server-url <url>', false, 'server url, e.g. ws://localhost:4557')
export class GenerateAsyncApi extends CliCommand {
  @Logger('cli')
  protected Log: Log;

  public async execute(options: GenerateAsyncApiOptions): Promise<void> {
    const manifest = await readManifest(options.manifest);
    const doc = manifestToAsyncApi(manifest, {
      title: options.title ?? manifest.app.name,
      version: options.docVersion,
      serverUrl: options.serverUrl,
    });

    await writeFile(options.out, JSON.stringify(doc, null, 2));
    this.Log.info(`AsyncAPI document written to ${options.out}`);
  }
}
