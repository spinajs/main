import { CodedHttpExceptionResponse, HandleException, HTTP_STATUS_CODE, NotFound, Ok, RawJsonResponse } from '@spinajs/http';
import { Decoy } from './vendor/decoy-lib/index.js';

class A extends Error {}
class B extends Error {}
class C extends Error {}
class D extends Error {}

@HandleException(A)
export class Accepted extends Ok {
  protected _errorCode = HTTP_STATUS_CODE.ACCEPTED;
}

@HandleException(B)
export class Missing extends NotFound {}

@HandleException(C)
export class Raw extends RawJsonResponse {}

@HandleException(D)
export class Teapot extends Ok {
  protected _errorCode = 418;
}

class F extends Error {}
const computed = (): number => 503;

@HandleException(F)
export class Computed extends Ok {
  protected _errorCode = computed();
}

class G extends Error {}
class H extends Error {}

@HandleException(G)
export class Coded extends CodedHttpExceptionResponse {}

const Mid = class extends Ok {
  protected _errorCode = HTTP_STATUS_CODE.ACCEPTED;
};

@HandleException(H)
export class FromExpression extends Mid {}

class I extends Error {}

@HandleException(I)
export class FromDecoy extends Decoy {}
