---
"@spinajs/authz": patch
---

`checkAll()` no longer fails the whole batch when one entry's check throws, for example because its adapter's `ancestors()` rejects or refuses the ref. That entry is logged at error and answered with a denial whose reason is `model_error`; the other entries are answered as before. So `POST /user/access/checks` of `@spinajs/authz-http` answers `false` with `model_error` for that entry instead of a 500 for the request. `check()`, `can()` and `assert()` still throw the error.
