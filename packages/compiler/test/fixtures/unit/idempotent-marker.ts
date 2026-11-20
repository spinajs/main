import { BaseController, BasePath, Idempotent as Once, Ok, Post } from '@spinajs/http';
import type { IdempotentOptions } from '@spinajs/http';

declare function chosenOptions(): IdempotentOptions;

@BasePath('orders')
export class IdemOrdersController extends BaseController {
  @Post()
  @Once({ required: true, ttl: '1h' })
  public create(): Ok {
    return new Ok();
  }

  @Post()
  @Once({ required: true })
  @Once()
  public stacked(): Ok {
    return new Ok();
  }

  @Post()
  @Once()
  public draft(): Ok {
    return new Ok();
  }

  @Post()
  @Once(chosenOptions())
  public chosen(): Ok {
    return new Ok();
  }

  @Post()
  public plain(): Ok {
    return new Ok();
  }
}
