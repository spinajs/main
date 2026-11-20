---
"@spinajs/http": patch
---

The 504 of a request deadline (`http.deadline`, `@Deadline`) is sent in place of the route's reply and is no longer held to the route's response schema under contract testing. Before, it was checked against that schema whenever the validator had one for the status: a route that documents a 504 of its own, or a custom `ContractValidator` that judges every status. In `throw` mode the 504 could then not be sent and the client got a closed connection; in `log` mode a violation was recorded. Also, the policy gate no longer evaluates the policies when the deadline's 504 was sent while a `'beforePolicy'` middleware was still running; nothing after the gate runs for such a request.
