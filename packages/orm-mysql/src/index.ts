// import { Injectable } from '@spinajs/di';
// import { QueryContext, OrmDriver, IColumnDescriptor, QueryBuilder, TransactionCallback } from '@spinajs/orm';
// import { SqlDriver } from '@spinajs/orm-sql';
 
// @Injectable('orm-driver-mysql')
// export class MySqlOrmDriver extends SqlDriver {
//   public execute(stmt: string | object, params: any[], context: QueryContext): Promise<any> {
//     throw new Error('Method not implemented.');
//   }
//   public async ping(): Promise<boolean> {
//     try {
//       await this.execute('SELECT 1', [], QueryContext.Select);
//       return true;
//     } catch {
//       return false;
//     }
//   }
//   public connect(): Promise<OrmDriver> {
//     const pool = mysql.createPool({
//       host: 'localhost',
//       user: 'root',
//       database: 'test',
//       waitForConnections: true,
//       connectionLimit: 10,
//       queueLimit: 0,
//     });
//   }
//   public disconnect(): Promise<OrmDriver> {}
//   public tableInfo(name: string, schema?: string): Promise<IColumnDescriptor[]> {}
//   public transaction(queryOrCallback?: QueryBuilder<any>[] | TransactionCallback): Promise<void> {}
// }
