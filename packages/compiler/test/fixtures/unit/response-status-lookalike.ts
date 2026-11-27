declare function HandleException(...exceptions: unknown[]): ClassDecorator;

class E extends Error {}
class Response { protected _errorCode = 200; }
class Ok extends Response { public data: unknown; }

@HandleException(E)
export class Fine extends Ok {}
