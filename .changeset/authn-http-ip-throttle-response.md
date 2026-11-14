---
"@spinajs/authn-http": patch
---

`AuthnIpThrottleMiddleware` answers a throttled client itself: its `onBefore` returns the route's throttled `Response` instead of throwing `AuthnIpThrottled`, and `@IpThrottle` no longer adds the `@OnError(AuthnIpThrottled, ..., { stages: ['middleware'] })` handler. The answer is unchanged. The constructor takes the answer, `(flow, answer, mode = 'gate')`, and `AuthnIpThrottled` is removed; neither is exported from the package.
