/**
 * Object-form decorators with `choices` and a variadic argument.
 *
 * Run:
 *   spinajs build api web                 # builds both, target defaults to "dev"
 *   spinajs build api --target prod
 *   spinajs build api --target staging    # rejected: not in choices
 */
import { Log, Logger } from '@spinajs/log';
import { CliCommand, Command, Argument, Option } from '@spinajs/cli';

interface BuildOptions {
  target: string;
}

@Command({ nameAndArgs: 'build', description: 'Build one or more projects' })
@Argument({ name: 'projects', required: true, variadic: true, description: 'projects to build' })
@Option({
  flags: '-t, --target <target>',
  required: false,
  description: 'build target',
  choices: ['dev', 'prod'],
  defaultValue: 'dev',
})
export class BuildCommand extends CliCommand {
  @Logger('build')
  protected Log: Log;

  // a variadic argument is delivered as an array
  public async execute(projects: string[], options: BuildOptions): Promise<void> {
    this.Log.info(`Building ${projects.join(', ')} for target "${options.target}"`);
  }
}
