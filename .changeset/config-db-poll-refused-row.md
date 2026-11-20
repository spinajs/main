---
"@spinajs/configuration-db-source": patch
---

A stored option value that a configuration schema refuses no longer stops the rest of the watch poll: it keeps its previous value, the other changed rows are applied, and the refusal is logged once, naming the slug. The row is tried again once its value changes.
