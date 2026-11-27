---
"@spinajs/orm": patch
"@spinajs/orm-sql": patch
---

A `whereExist()` / `whereNotExists()` on a hasMany or belongsTo relation whose callback adds an `OR` now matches only the related rows of each outer row. Before, the callback's `OR` captured the sub-select's correlation predicate: `Order.query().whereExist('Items', function () { this.where('Sku', 'B').orWhere('Sku', 'Q') })` compiled to `WHERE Sku = ? OR Sku = ? AND order_id = order.Id` and returned every order as soon as any item had Sku `B`, and the same `whereNotExists()` returned none. The correlation is now marked as a condition the ORM added and stays outside the callback's group: `WHERE ( Sku = ? OR Sku = ? ) AND order_id = order.Id`, behind the soft-delete filter of a soft-delete target. The SQL of such sub-selects changes (brackets); a callback without a top-level `OR` and a many-to-many `whereExist()` compile as before.
