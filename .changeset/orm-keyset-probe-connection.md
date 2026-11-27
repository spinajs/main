---
"@spinajs/orm": patch
---

`paginate()`: the probe that decides whether a refused cursor value is reported as `InvalidCursor` now runs on the connection the page query read. Before, it was routed again: a page read with `onPrimary()` or a row lock was probed on a read replica, and with several connections the round robin sent the probe to the next one, so a lagging replica could decide the error over rows the page did not read.
