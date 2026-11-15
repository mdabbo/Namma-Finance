# Test summary — 0.8.0 Beta

> **A local run is not release evidence.** The authoritative record is the
> `Quality gates` GitHub Actions run on the released commit. Record its URL and
> SHA in `RELEASE-CHECKLIST.md`. Do not claim gates passed until that run is
> green.

## Local gates (not evidence)

Run on branch `chore/release-0.8.0` on top of `main` at `6b74bb7`:

| Gate | Result |
| --- | --- |
| `pnpm version:check` | verifies 0.8.0 (Beta), schema 30 |
| `pnpm test` (core, desktop, release scripts) | run before commit; see the commit message |
| `cargo test` | run before commit |

Fill this table from the actual run before publishing. Do not copy figures from
0.7.0.

## CI evidence

Pending: the `Quality gates` run for the release commit.
