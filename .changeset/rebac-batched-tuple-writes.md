---
"@spinajs/authz-rebac": patch
---

`DbTupleStore` writes the stored tuples a call removes in one `DELETE` per 500 and the new ones in one `INSERT` per 100, instead of one statement and one savepoint per tuple, and never more rows a statement than `db.WriteCapture.MaxRows` when that is set lower, so the write capture's row limit refuses no call that worked before. A batch that loses an insert race is repeated one row at a time; a caveat conflict among a call's additions, or with a stored tuple, is refused before any of them is inserted.
