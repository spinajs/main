---
"@spinajs/orm-sql": patch
---

`SqlTimeValueConverter.toDB()` writes a negative time span as the exact negative of its positive twin: `-02:30` is written as `-02:30:00`, no longer as `-03:30:00`. Every negative span that was not a whole number of hours was written one hour further from zero.
