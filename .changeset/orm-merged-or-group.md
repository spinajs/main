---
"@spinajs/orm": patch
---

A nested belongs-to populate's conditions no longer sit under its parent callback's `orWhere()`. When a belongs-to callback holds an OR and populates another belongs-to relation with conditions, the nested group is ANDed beside the callback's group instead of inside it: `( a OR b ) AND ( nested )` replaces `( a OR b AND ( nested ) )`, which kept every row matching `a` whatever the nested condition. A belongs-to callback without conditions of its own no longer wraps a nested group in a second pair of parentheses.
