---
"@spinajs/orm": patch
---

`Model.query().populate(<belongs-to relation>)` keeps the queried model's own columns. With no column selected, the relation's joined columns replaced the implicit `*`, and every row came back with only the related model filled in and its own `Id` and other columns `null`.
