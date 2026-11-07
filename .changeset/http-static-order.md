---
"@spinajs/http": major
---

Static files (`http.Static`) mount among the server middlewares at the new `http.static.order`, 4.5 by default (after `CsrfGuard`, before authentication), instead of after all of them. A static request no longer runs authentication, `PrincipalMiddleware`, `AccessEpochMiddleware` or any server middleware above that order, so the `authn.http.hooks.request` refusal hook and the session `Cache-Control: no-store` no longer apply to static files; the server middlewares below that order still run for them and get `onFinish`. `http.static.order: Infinity` restores the 3.x placement.
