// Keys and values arrive as tag text: the ORM renders them (rowTagKey, tagValue of @spinajs/orm), so that the read side
// and the write side name the same tag; this package does not know column semantics.

/** A lookup by primary key (C3). */
export const rowTag = (table: string, key: string): string => `row:${table}:${key}`;

/** A statement confined to one value of a partition column (C3). */
export const partTag = (table: string, column: string, value: string): string => `part:${table}:${column}=${value}`;

/** Every other statement on the table (C3). */
export const anyTag = (table: string): string => `any:${table}`;

/** Carried by every row and partition entry; bumped by a write whose rows are not known (C3). */
export const bulkTag = (table: string): string => `bulk:${table}`;
