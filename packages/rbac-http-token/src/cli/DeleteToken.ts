import { Log, Logger } from '@spinajs/log';
import { Argument, Command } from '@spinajs/cli';
import { RbacCliCommand } from '@spinajs/rbac';

import { deleteToken } from '../actions.js';

@Command('rbac:token-delete', 'Deletes ( revokes ) an access token')
@Argument('uuid', true, 'token uuid')
export class DeleteToken extends RbacCliCommand {
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
