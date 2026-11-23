---
"@spinajs/audit": patch
---

The warning that a store could not tell whether it joins the caller is logged once per trail instead of once per service, so a second trail with the same problem is reported too.
