import { HandleException, NotFound, Ok } from '@spinajs/http';
import { ResourceNotFound, InvalidArgument } from '@spinajs/exceptions';

@HandleException(ResourceNotFound)
export class MissingThing extends NotFound {}

@HandleException([InvalidArgument, TypeError])
export class BadThing extends MissingThing {}

@HandleException(RangeError)
export class Plain extends Ok {}

export class NotAResponse {}

@HandleException(EvalError)
export class Unknown extends NotAResponse {}
