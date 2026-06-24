/**
 * Options backed by configuration (`configKey`) and environment (`env`).
 *
 * Resolution order for each option: value on the command line, else the
 * env var / configuration value, else undefined.
 *
 * Run:
 *   spinajs serve                 # port from config `http.port`, host from $HOST
 *   spinajs serve --port 8080     # explicit value wins
 */
import { Log, Logger } from '@spinajs/log';
import { CliCommand, Command, Option } from '@spinajs/cli';

interface ServeOptions {
  port?: number;
  host?: string;
}

@Command({ nameAndArgs: 'serve', description: 'Start the HTTP server' })
@Option({
  flags: '-p, --port <port>',
  required: false,
  description: 'port to listen on',
  configKey: 'http.port', // falls back to @spinajs/configuration
  parser: (v) => parseInt(v, 10),
})
@Option({
  flags: '-H, --host <host>',
  required: false,
  description: 'host to bind to',
  env: 'HOST', // falls back to the HOST environment variable
})
export class ServeCommand extends CliCommand {
  @Logger('serve')
  protected Log: Log;

  public async execute(options: ServeOptions): Promise<void> {
    this.Log.info(`listening on ${options.host ?? '0.0.0.0'}:${options.port ?? 3000}`);
  }
}
