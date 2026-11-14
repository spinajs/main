import { DI } from '@spinajs/di';
import { BaseController, BasePath, Get, Ok } from '@spinajs/http';
import { Orm, wroteInScope } from '@spinajs/orm';

@BasePath('read-your-writes')
export class ReadYourWritesC extends BaseController {
  @Get()
  public async write() {
    const driver = DI.get(Orm)!.Connections.get('sqlite')!;
    const before = wroteInScope(driver);
    await driver.update().in('test').update({ Text: 'witaj' }).where({ Id: 1 });
    return new Ok({ before, after: wroteInScope(driver) });
  }
}
