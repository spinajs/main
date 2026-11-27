// Application classes named like the http replies; their base is named `Response` too, but is not the http one.
export class Response<T> { constructor(public data: T) {} }
export class Ok<T> extends Response<T> {}
export class Json<T> extends Response<T> {}
export class Created<T> extends Response<T> {}
export class NotFound<T> extends Response<T> {}
export class ServerError<T> extends Response<T> {}
export class Unauthorized<T> extends Response<T> {}
export class Conflict<T> extends Response<T> {}
export class NoContent<T> extends Response<T> {}
export class ValidationError<T> extends Response<T> {}
export class NotAllowed<T> extends Response<T> {}
export class EntityTooLarge<T> extends Response<T> {}
export class BadRequest<T> extends Response<T> {}
export class Forbidden<T> extends Response<T> {}
