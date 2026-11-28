import * as Http from '@spinajs/http';
import { Ok as Fine, NotFound as Missing } from '@spinajs/http';
import { BadRequest, Forbidden } from '@spinajs/exceptions';
import type { ModelData, ModelDataWithRelationData } from '@spinajs/orm';
import * as InHttpFolder from './inner/http/replies.js';
import * as Again from './reply-reexports.js';
import * as App from './reply-lookalikes.js';
import * as Lib from './vendor/reply-lib/index.js';
import * as Look from './wrapper-lookalikes.js';

export class Payload { id!: number }

export interface AppReplies {
  Ok: App.Ok<Payload>;
  Json: App.Json<Payload>;
  Created: App.Created<Payload>;
  NotFound: App.NotFound<Payload>;
  ServerError: App.ServerError<Payload>;
  Unauthorized: App.Unauthorized<Payload>;
  Conflict: App.Conflict<Payload>;
  NoContent: App.NoContent<Payload>;
  ValidationError: App.ValidationError<Payload>;
  NotAllowed: App.NotAllowed<Payload>;
  EntityTooLarge: App.EntityTooLarge<Payload>;
  BadRequest: App.BadRequest<Payload>;
  Forbidden: App.Forbidden<Payload>;
}

export interface LibReplies {
  Ok: Lib.Ok<Payload>;
  Json: Lib.Json<Payload>;
  Created: Lib.Created<Payload>;
  NotFound: Lib.NotFound<Payload>;
  ServerError: Lib.ServerError<Payload>;
  Unauthorized: Lib.Unauthorized<Payload>;
  Conflict: Lib.Conflict<Payload>;
  NoContent: Lib.NoContent<Payload>;
  ValidationError: Lib.ValidationError<Payload>;
  NotAllowed: Lib.NotAllowed<Payload>;
  EntityTooLarge: Lib.EntityTooLarge<Payload>;
  BadRequest: Lib.BadRequest<Payload>;
  Forbidden: Lib.Forbidden<Payload>;
}

// http has no reply class named `BadRequest` or `Forbidden`: those two are exceptions of @spinajs/exceptions.
export interface HttpReplies {
  Ok: Http.Ok<Payload>;
  Json: Http.Json<Payload>;
  Created: Http.Created<Payload>;
  NotFound: Http.NotFound<Payload>;
  ServerError: Http.ServerError<Payload>;
  Unauthorized: Http.Unauthorized<Payload>;
  Conflict: Http.Conflict<Payload>;
  NoContent: Http.NoContent<Payload>;
  ValidationError: Http.ValidationError<Payload>;
  NotAllowed: Http.NotAllowed<Payload>;
  EntityTooLarge: Http.EntityTooLarge<Payload>;
  BadRequest: Http.BadRequestResponse<Payload>;
  Forbidden: Http.ForbiddenResponse<Payload>;
}

export interface ReexportedReplies {
  Ok: Again.HttpOk<Payload>;
  Json: Again.HttpJson<Payload>;
  Created: Again.HttpCreated<Payload>;
  NotFound: Again.HttpNotFound<Payload>;
  ServerError: Again.HttpServerError<Payload>;
  Unauthorized: Again.HttpUnauthorized<Payload>;
  Conflict: Again.HttpConflict<Payload>;
  NoContent: Again.HttpNoContent<Payload>;
  ValidationError: Again.HttpValidationError<Payload>;
  NotAllowed: Again.HttpNotAllowed<Payload>;
  EntityTooLarge: Again.HttpEntityTooLarge<Payload>;
  BadRequest: Again.HttpBadRequest<Payload>;
  Forbidden: Again.HttpForbidden<Payload>;
}

export class MyOk extends Http.Ok<Payload> {}
export class MyJson extends Http.Json<Payload> {}
export class MyCreated extends Http.Created<Payload> {}
export class MyNotFound extends Http.NotFound<Payload> {}
export class MyServerError extends Http.ServerError<Payload> {}
export class MyUnauthorized extends Http.Unauthorized<Payload> {}
export class MyConflict extends Http.Conflict<Payload> {}
export class MyNoContent extends Http.NoContent<Payload> {}
export class MyValidationError extends Http.ValidationError<Payload> {}
export class MyNotAllowed extends Http.NotAllowed<Payload> {}
export class MyEntityTooLarge extends Http.EntityTooLarge<Payload> {}
export class MyBadRequest extends Http.BadRequestResponse<Payload> {}
export class MyForbidden extends Http.ForbiddenResponse<Payload> {}

export interface SubclassedReplies {
  Ok: MyOk;
  Json: MyJson;
  Created: MyCreated;
  NotFound: MyNotFound;
  ServerError: MyServerError;
  Unauthorized: MyUnauthorized;
  Conflict: MyConflict;
  NoContent: MyNoContent;
  ValidationError: MyValidationError;
  NotAllowed: MyNotAllowed;
  EntityTooLarge: MyEntityTooLarge;
  BadRequest: MyBadRequest;
  Forbidden: MyForbidden;
}

type Promised<R> = { [K in keyof R]: Promise<R[K]> };
export interface PromisedAppReplies extends Promised<AppReplies> {}
export interface PromisedLibReplies extends Promised<LibReplies> {}
export interface PromisedHttpReplies extends Promised<HttpReplies> {}

type OkAlias<T> = Http.Ok<T>;
export interface ImportedAsReplies {
  Fine: Fine<Payload>;
  Missing: Promise<Missing<Payload>>;
  OkAlias: OkAlias<Payload>;
}

type MissingPayload = Http.NotFound<Payload>;
type OkList<T> = Http.Ok<T[]>;
export interface AliasedReplies {
  MissingPayload: MissingPayload;
  PromisedMissingPayload: Promise<MissingPayload>;
  OkList: OkList<Payload>;
}

export interface ModelDataReplies {
  PromisedModelData: Promise<ModelData<Payload>>;
  OkModelData: Http.Ok<ModelData<Payload>>;
  PromisedModelDataWithRelationData: Promise<ModelDataWithRelationData<Payload>>;
  OkModelDataWithRelationData: Http.Ok<ModelDataWithRelationData<Payload>>;
}

type DataOf<T> = ModelData<T>;
type RelDataOf<T> = ModelDataWithRelationData<T>;
type UserData = ModelData<Payload>;
type DataAgain<T> = DataOf<T>;
type Swap<A, B> = ModelData<B>;
type Middle<A, B, C> = ModelData<B>;
type ListData<T> = ModelData<T[]>;
type H1<T> = ModelData<T>;
type H2<T> = H1<T>;
type H3<T> = H2<T>;
type H4<T> = H3<T>;
type H5<T> = H4<T>;
type H6<T> = H5<T>;
type H7<T> = H6<T>;
type H8<T> = H7<T>;
type H9<T> = H8<T>;
type H10<T> = H9<T>;
type H11<T> = H10<T>;
type H12<T> = H11<T>;
type H13<T> = H12<T>;
type H14<T> = H13<T>;
type H15<T> = H14<T>;
type H16<T> = H15<T>;
export interface ModelDataAliases {
  DataOf: DataOf<Payload>;
  PromisedDataOf: Promise<DataOf<Payload>>;
  RelDataOf: RelDataOf<Payload>;
  UserData: UserData;
  OkUserData: Http.Ok<UserData>;
  DataAgain: DataAgain<Payload>;
  Swap: Swap<string, Payload>;
  Middle: Middle<string, Payload, number>;
}
export interface ModelDataListAlias {
  ListData: ListData<Payload>;
}
export interface ModelDataAliasChains {
  H15: H15<Payload>;
  H16: H16<Payload>;
}

type AsyncOk<T> = Promise<Http.Ok<T>>;
type PromiseList<T> = Promise<T[]>;
type PromisedPayload = Promise<Payload>;
export interface PromiseAliases {
  AsyncOk: AsyncOk<Payload>;
  PromiseList: PromiseList<Payload>;
  PromisedPayload: PromisedPayload;
}

type LookAsync<T> = Look.Promise<T>;
type LookData<T> = Look.ModelData<T>;
export interface WrapperLookalikes {
  Promise: Look.Promise<Payload>;
  AliasedPromise: LookAsync<Payload>;
  ModelData: Look.ModelData<Payload>;
  AliasedModelData: LookData<Payload>;
  ModelDataWithRelationData: Look.ModelDataWithRelationData<Payload>;
}

export interface HttpFolderReplies {
  Ok: InHttpFolder.Ok<Payload>;
  NotFound: InHttpFolder.NotFound<Payload>;
}

export class MyGenericOk<T> extends Http.Ok<T> {}
export interface GenericSubclassReplies {
  MyGenericOk: MyGenericOk<Payload>;
}

export interface Exceptions {
  BadRequest: BadRequest;
  Forbidden: Forbidden;
}
