/**
 * Advanced option shapes: mutually exclusive (`conflicts`), a negatable
 * option, and an optional-value option with a `preset`.
 *
 * Run:
 *   spinajs logs --json
 *   spinajs logs --json --pretty   # rejected: conflicting options
 *   spinajs logs --level           # level = "info" (the preset)
 *   spinajs logs --level debug      # level = "debug"
 *   spinajs logs --no-color
 */
import { CliCommand, Command, Option } from '@spinajs/cli';

interface LogsOptions {
  json?: boolean;
  pretty?: boolean;
  color: boolean; // negatable: --no-color sets this to false
  level?: string; // optional value with a preset
}

@Command({ nameAndArgs: 'logs', description: 'Show application logs' })
@Option({ flags: '--json', required: false, description: 'output as JSON', conflicts: 'pretty' })
@Option({ flags: '--pretty', required: false, description: 'pretty, human-readable output' })
@Option('--no-color', false, 'disable colored output')
@Option({ flags: '--level [level]', required: false, description: 'minimum level to show', preset: 'info' })
export class LogsCommand extends CliCommand {
  // negatable / optional-value options are expressed entirely in the flags string
  public async execute(options: LogsOptions): Promise<void> {
    // eslint-disable-next-line no-console
    console.log(options);
  }
}
