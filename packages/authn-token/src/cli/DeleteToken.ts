import { Log, Logger } from '@spinajs/log';
import { Argument, CliCommand, Command } from '@spinajs/cli';

import { deleteToken } from '../actions.js';

@Command('rbac:token-delete', 'Deletes ( revokes ) an access token')
@Argument('uuid', true, 'token uuid')
export class DeleteToken extends CliCommand {
  @Logger('rbac-http-token')
  protected Log: Log;

  public async execute(uuid: string): Promise<void> {
    try {
      await deleteToken(uuid);
      this.Log.success(`Token ${uuid} deleted`);
    } catch (e) {
      this.Log.error(`Error while deleting token ${uuid}: ${(e as Error).message}`);
    }
  }
}
