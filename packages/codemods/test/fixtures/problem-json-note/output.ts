import { HandleException } from '@spinajs/http';

// TODO(spinajs-4): error bodies are application/problem+json, see docs/upgrading/4.0.md
@HandleException(MyError)
export class MyController {
  // TODO(spinajs-4): error bodies are application/problem+json, see docs/upgrading/4.0.md
  @HandleException(OtherError)
  public get() {}

  // TODO(spinajs-4): error bodies are application/problem+json, see docs/upgrading/4.0.md
  @HandleException(AlreadyNoted)
  public post() {}
}
