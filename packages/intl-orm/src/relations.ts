// import { NewInstance } from '@spinajs/di';
// import { BelongsToRecursiveRelation, BelongsToRelation, ManyToManyRelation, OneToManyRelation } from '@spinajs/orm';

// declare module '@spinajs/orm' {
//   export interface IOrmRelation {
//     translate(lang: string): void;
//   }
// }

// @NewInstance()
// export class IntlBelongsToRelation extends BelongsToRelation {
//   public translate(lang: string): void {
//     this._relationQuery.translate(lang);
//   }
// }

// @NewInstance()
// export class IntlBelongsToRecursiveRelation extends BelongsToRecursiveRelation {
//   public translate(lang: string): void {
//     this._relationQuery.translate(lang);
//   }
// }

// @NewInstance()
// export class IntlOneToManyRelation extends OneToManyRelation {
//   public translate(lang: string): void {
//     this._relationQuery.translate(lang);
//   }
// }

// @NewInstance()
// export class IntlManyToManyRelation extends ManyToManyRelation {
//   public translate(lang: string): void {
//     this._relationQuery.translate(lang);
//   }
// }
