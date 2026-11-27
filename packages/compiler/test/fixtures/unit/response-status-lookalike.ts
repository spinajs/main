declare function HandleException(...exceptions: unknown[]): ClassDecorator;

class E extends Error {}
class Ok { public data: unknown; protected _errorCode = 200; }

@HandleException(E)
export class Fine extends Ok {}
