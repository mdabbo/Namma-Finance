# Test summary — 0.8.0 Beta

> **A local run is not release evidence.** The authoritative record is the
> `Quality gates` GitHub Actions run on the released commit. Nothing below is
> cited as proof of a gate unless it names that run.

## Released commit

| | |
| --- | --- |
| Tag | `v0.8.0` (annotated), on merge commit `125f8e1` |
| Tree | identical to `efcbd8b`, the PR #23 head that the local gates ran on |
| Release PR | [#23](https://github.com/mdabbo/Namma-Finance/pull/23) |

## CI evidence

`Quality gates` run
[43769050022](https://github.com/mdabbo/Namma-Finance/actions/runs/43769050022)
on `125f8e1fe61121ac29d85fcd52edd7a8a54e34a6`, event `push` to `main`,
conclusion **success**.

| Job | Result |
| --- | --- |
| TypeScript and unit tests | success |
| Rust quality | success |
| Playwright E2E | success |
| Desktop production build | success |

The PR #23 run on `efcbd8b`
([43767962559](https://github.com/mdabbo/Namma-Finance/actions/runs/43767962559))
also passed all four jobs before the merge.

## Local gates (supporting only)

Run on `efcbd8b`, the same tree as the released commit:

| Gate | Result |
| --- | --- |
| `pnpm version:check` | verified 0.8.0 (Beta), schema 30 |
| `node --test scripts/sync-version.test.mjs scripts/text-eol.test.mjs` | 11 pass, 0 fail |
| `pnpm lint` | 0 errors |
| `pnpm typecheck` | pass |
| `pnpm test` in `packages/core` | 246 / 246 |
| `pnpm test` in `apps/desktop` | 494 / 494 |
| `cargo fmt --check` | pass |
| `cargo test` | 61 / 61 |

## Not run for this release

- E2E and the packaged build were not re-run locally; their evidence is the CI
  run above.
- The two-PC acceptance in `docs/TWO-PC-SYNC-ACCEPTANCE.md` and a clean-machine
  install of the packaged app remain open.
