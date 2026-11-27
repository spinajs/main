---
"@spinajs/orm": patch
"@spinajs/orm-sql": patch
---

`whereExist()` / `whereNotExists()` on a hasMany or belongsTo relation, with a callback that adds a top-level `OR`, now tests only the related rows of each outer row. Before, the `OR` captured the sub-select's correlation predicate, so the sub-select matched rows of other parents: `Order.query().whereExist('Items', function () { this.where('Sku', 'B').orWhere('Sku', 'Q') })` compiled to `WHERE Sku = ? OR Sku = ? AND order_id = order.Id` and returned every order as soon as any item had Sku `B`, and the same `whereNotExists()` returned none.

**Results change.** Such a `whereExist()` now returns fewer rows (only the outer rows that really have a matching related row), and such a `whereNotExists()` returns more. The same holds for a `whereExist()` inside a `populate()` callback, which now loads fewer related rows. An application that relied on the old, too wide result will see different data.

The correlation is now a condition the ORM added and stays outside the callback's group: `WHERE ( Sku = ? OR Sku = ? ) AND order_id = order.Id`, after the soft-delete or archive filter of the target. Bindings do not change. A callback without a top-level `OR`, `whereExist(relation)` without a callback, and a many-to-many `whereExist()` compile exactly as before.
