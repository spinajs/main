---
"@spinajs/di": major
---

`container.child({ isolateSingletons: true })`: singletons resolved through the child are owned by the child even when registered in an ancestor, so a disposed child takes its instances with it.
