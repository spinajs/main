import { HandleException } from '@spinajs/http';

@HandleException(MyError)
export class MyController {
  @HandleException(OtherError)
  public get() {}

  // TODO(spinajs-4): error bodies are application/problem+json, see docs/upgrading/4.0.md
  @HandleException(AlreadyNoted)
  public post() {}
}
