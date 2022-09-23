import { Injectable } from '@spinajs/di';
import { guessLanguage, defaultLanguage } from '@spinajs/intl';
import { QueryBuilder, QueryMiddleware, SelectQueryBuilder } from '@spinajs/orm';

@Injectable(QueryMiddleware)
export class RbacModelPermissionMiddleware extends QueryMiddleware {
  afterQueryCreation(builder: QueryBuilder) {
    if (builder instanceof SelectQueryBuilder) {
      const lang = guessLanguage();
      const dLang = defaultLanguage();

      if (lang && dLang !== lang) {
        builder.translate(lang);
      }
    }
  }
}
