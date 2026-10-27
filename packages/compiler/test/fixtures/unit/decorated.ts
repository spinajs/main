import { OBJ, Kind, Base } from './context.js';

declare function D(...a: unknown[]): ClassDecorator;

@D(OBJ, Kind.A, Base)
export class Decorated {}
