---
"@spinajs/di": major
---

`register(X).as(Base, { replace: true })`: re-registering a class of the same name moves it to the last position, so the last registration wins. Without the option a re-registration keeps its first position, as before.
