# Action hooks

`DefaultKeyRegistry` runs `register` and `revoke` through the [`@spinajs/hooks`](../hooks/README.md) runner. A hook can refuse them and observe each before and after it runs.

## Actions

| Action | Method | Input | Refusable | Refused answer |
| --- | --- | --- | --- | --- |
| `authn.key.register` | `register` | `reg`, `ctx` | yes | `{ ok: false, code: 'refused', refusal }`; the route answers 403 `{ code }` |
| `authn.key.revoke` | `revoke` | `owner`, `kid`, `actor?`, `ctx` | yes | `false`; the route answers 404 `key_not_found`, as for an unknown key |

No input key is mutable. `refusal` is the hook's code, or `hook_error` for a hook that failed. A refusal is audited as `key.register` or `key.revoke` with outcome `failure` and the reason `hook:<code>` or `hook_error`.

## Important behaviour

- **Register runs its hooks once the key is checked:** the JWK, the kid, the expiry, the name, the scope, and the proof of a user key or the actor of a service or agent key. An invalid registration answers as before and reaches no hook. The proof's challenge is redeemed before the hooks run, so a refused user key needs a new challenge.
- **`KeyRegisterResult` has a new member,** `{ ok: false; code: 'refused'; refusal: string }`. An exhaustive match on `code` needs a branch for it.
- **Without hooks.** A registry built with `new DefaultKeyRegistry(deps)` runs `deps.hooks` when given and no hook otherwise.

## Related

- [Key registry](02-key-registry.md): the methods these actions wrap.
- [`@spinajs/authn-http` action hooks](../authn-http/23-action-hooks.md): the route answers.
