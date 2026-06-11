# Contributing to drep.tools

Thanks for your interest in improving drep.tools, a coordination platform for
Cardano DReps and delegators. Contributions of all sizes are welcome: bug
reports, fixes, docs, and features.

## Reporting bugs and requesting features

Open a [GitHub issue](https://github.com/adamrusch/drep-platform/issues/new).
For bugs, include what you did, what you expected, and what happened, plus
the network you were on (mainnet via `drep.tools` or staging via
`test.drep.tools`) and any console or server output.

For suspected security issues, please do not open a public issue. See
[Security](#security) below.

## Repository layout

drep.tools is an npm-workspace monorepo with three workspaces and a shared
folder:

| Path | Purpose |
|------|---------|
| `backend/`  | AWS Lambda handlers (Node.js 20.x, ARM64), DynamoDB access, sync workers. |
| `frontend/` | React 18 + Vite 5 SPA. |
| `infra/`    | AWS CDK (TypeScript) stacks: `api-stack.ts`, `database-stack.ts`, `frontend-stack.ts`, `scheduler-stack.ts`. |
| `shared/`   | Canonical files duplicated into each workspace (e.g. `committeeMessages.ts`, `freshness.ts`, `cip20.ts`). Each workspace has a byte-identical copy in its `lib/` dir; drift-guard tests pin the copies. |
| `docs/`     | Architecture decisions, runbook, schema, security review, Phase 2 plan. |

Cross-workspace imports are deliberately avoided — see
`backend/src/lib/types.ts`. When a file needs to live in more than one
workspace, the canonical source goes under `shared/`, copies live in each
consuming workspace's `lib/`, and a drift-guard test pins them byte-identical
in CI.

## Getting set up

Each workspace has its own `package.json` and `node_modules`:

```sh
cd backend  && npm install
cd frontend && npm install
cd infra    && npm install
```

Local dev runs each workspace independently — there is no top-level dev
server because the Lambda handlers run in AWS. The frontend `npm run dev`
proxies `/api/*` to a local backend if you wire one up; for most local
work the production API is fine.

## Development workflow

1. Fork the repository and create a branch off `main`. Use a descriptive,
   prefixed name: `feat/`, `fix/`, `docs/`, `chore/`, or `refactor/`
   (for example `fix/committee-deadline-sweep`).
2. Make your change. Keep each pull request focused on one thing; smaller,
   self-contained changes are easier to review and merge.
3. Make sure the checks below pass locally for the workspaces you touched.
4. Open a pull request against `main` with a clear description of what
   changed and why.

### Checks that must pass

Run these in the workspaces you changed before opening a PR:

```sh
# Backend
cd backend
npm run typecheck                # tsc --noEmit, must be clean
npm run lint                     # biome lint on src/lib/identity, must be clean
npm run audit:prod               # high+critical only, must be clean
npm test                         # vitest, all tests green

# Frontend
cd frontend
npm run typecheck                # tsc --noEmit, must be clean
npm test                         # vitest, all tests green

# Infra
cd infra
npm run typecheck                # tsc --noEmit, must be clean
```

CI runs the same gates on every pull request. Drift-guard tests live in the
backend test suite (they fs.readFileSync the canonical and mirror copies and
assert byte-identity), so a change to a `shared/*.ts` file requires updating
its mirrors in the other workspaces too — the backend test will fail
otherwise.

### Code style

Backend lint runs Biome against `src/lib/identity` only — the rest of the
backend tree has its own conventions baked into existing code; match the
style of the surrounding file when touching it. Scope formatting to the
lines you change so diffs stay reviewable.

Code comments and commit messages should be in English. Prefer comments
that explain *why* a piece of code exists over comments that restate *what*
it does — file headers across the repo tend to have a long-form rationale
section explaining the design trade-offs.

### Tests

Add or update tests for behaviour you change. Tests are co-located:
`Component.test.tsx` next to `Component.tsx`; `helper.test.ts` next to
`helper.ts`. Run `npm run test:watch` while developing.

The backend test suite is the largest (~900+ tests at last count) and runs
in under 5 seconds; the frontend suite is smaller (~70+) and uses
`@testing-library/react` with `jsdom`. The infra workspace has no test
runner today — its assertions live in the backend drift-guard tests.

## Commit and pull request conventions

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
with these prefixes:

`feat:` new feature, `fix:` bug fix, `i18n:` translations, `docs:`
documentation, `chore:` tooling and maintenance, `refactor:` non-behavioural
restructuring.

Keep the subject line short, specific, and in the imperative, for example
`fix: keep committee sweep idempotent across epoch boundaries`. PR titles
follow the same convention; the description should be a short, clear list
of what changed.

## Security

If you find a vulnerability, please report it privately rather than opening
a public issue, so it can be fixed before it is widely known. Email
[bugreport@rusch.me](mailto:bugreport@rusch.me) or use GitHub's private security
advisory feature for this repository. See [SECURITY.md](SECURITY.md) for
details. The identity subsystem has an engineering review at
[`docs/SECURITY_REVIEW_IDENTITY.md`](docs/SECURITY_REVIEW_IDENTITY.md).
