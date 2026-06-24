/**
 * Lifecycle hooks (`onPreAction` / `onPostAction`) and the `onCreation`
 * escape hatch for raw commander configuration.
 *
 * Run:
 *   spinajs deploy
 *   spinajs deploy --help     # note the extra help text added in onCreation
 */
import { Log, Logger } from '@spinajs/log';
import { CliCommand, Command, CommanderCommand } from '@spinajs/cli';

@Command({ nameAndArgs: 'deploy', description: 'Deploy the application' })
export class DeployCommand extends CliCommand {
  @Logger('deploy')
  protected Log: Log;

  private startedAt = 0;

  // raw commander command — use anything the decorators don't cover
  public onCreation(command: CommanderCommand): void {
    command.addHelpText('after', '\nExample:\n  $ spinajs deploy');
  }

  // runs before execute
  public onPreAction(): void {
    this.startedAt = Date.now();
    this.Log.info('deployment starting...');
  }

  // runs after execute
  public onPostAction(): void {
    this.Log.info(`deployment finished in ${Date.now() - this.startedAt}ms`);
  }

  public async execute(): Promise<void> {
    this.Log.info('deploying...');
  }
}
