---
'@spinajs/orm': patch
---

The write capture confines a captured update or delete to the rows its key select read (`AND <primary key> IN (<keys read>)`), so history, the ancestor table and change events now see every row the statement changed. Behaviour change, only for models with an interested write observer: a row another transaction commits into the statement's where after the key select is no longer changed by that statement, as if the statement ran at the moment of its key select. Statements of other models are sent unchanged.
