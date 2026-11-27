// An application folder named `http`: its classes are no http replies, whatever the path says.
export class Response<T> { constructor(public data: T) {} }
export class Ok<T> extends Response<T> {}
export class NotFound<T> extends Response<T> {}
