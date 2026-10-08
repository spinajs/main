# canvas C6 fixtures

Vendored byte for byte (LF, no BOM) from the canvas repo `coderush/canvas`,
branch `foundation/f06-c6-server-api`, commit `1803e0c9932bed8e0d982865ee12f754081111e9`.

| File | Source path | sha256 |
| --- | --- | --- |
| `capabilities.json` | `fixtures/authz/capabilities.json` | `b26693eba2a991289a9bc1723630f0f36c321ebda81302c7382c97ffff114a7a` |
| `state.json` | `fixtures/authz/state.json` | `9006c921506cb40220da88c09f61d40b3e51faf0c3b30ad0d3bd1e9f90682247` |
| `cases.json` | `fixtures/authz/cases.json` | `ee03c2634121d423569059c7272209ff86055c117652d483873774277b7f95a0` |

The local copies under `test/canvas-c6/c6/` and `test/canvas-c6/fixtures.ts` come from
`contracts/ts/server-api/src/{access,authz,state,reference,fixtures}.ts` at the same commit.

`extra-cases.json` is not from canvas. It holds the two cases pinned by SpinaJS design
decisions H21 and H27, pending upstream (CV1).

## Re-vendoring

```
git -C <canvas> show <commit>:fixtures/authz/<name>.json > fixtures/canvas-c6/<name>.json
```

Then update the commit above, the checksums here and in `test/canvas-c6/fixtures.test.ts`.
`.gitattributes` keeps these files out of line-ending conversion.
