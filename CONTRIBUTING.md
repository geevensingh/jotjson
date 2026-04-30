# Contributing to JotJSON

Thanks for contributing! This project follows a single set of guidelines for
both humans and AI agents. Please read these before opening a PR.

## Before You Start

1. Read [`DESIGN_SPEC.md`](DESIGN_SPEC.md) - it is the source of truth for
   product behavior, architecture, entities, and limits.
2. Read [`AGENTS.md`](AGENTS.md) - it is the authoritative coding, testing,
   security, and workflow guide. Everything below is a summary; `AGENTS.md`
   wins on any conflict.

## Tech Stack

- **Frontend:** Angular (latest LTS), standalone components, Signals, Angular
  Material, SCSS, MSAL Angular. Monaco editor (lazy-loaded). `jsonc-parser`
  for all user JSON/JSONC parsing.
- **Backend:** Azure Functions in TypeScript (Node).
- **Data:** Azure Cosmos DB (serverless).
- **Hosting / IaC:** Azure Static Web Apps; Bicep under `/infra`.

Do not introduce new frameworks, languages, ORMs, state libraries, CSS
frameworks, or cloud services without prior approval.

## Development Workflow

1. **Branch** off `main`: `git checkout -b feat/<short-slug>` or
   `fix/<short-slug>`.
2. **First-time setup**: copy
   `src/environments/environment.example.ts` to
   `src/environments/environment.ts`. The real file is gitignored - fill in
   your local Microsoft Entra External ID values for sign-in to work
   (`infra/README.md` -> "Auth setup" walks through provisioning). Leaving the
   placeholders in place is fine if you don't need to exercise auth locally;
   the toolbar will show a disabled "Sign in (not configured)" button.
3. **Code** following the conventions in `AGENTS.md` (strict TS, `OnPush`,
   `inject()`, Signals, kebab-case filenames, co-located `*.spec.ts`).
4. **Test** - add or update tests for any logic change. No test = not done.
5. **Validate** locally:
   - `npm run lint` (frontend and `api/`)
   - `npm test` (frontend and `api/`)
   - `npm run build` / `ng build --configuration production`
6. **Commit** in small, focused commits with imperative subjects
   (e.g., `Add slug collision check to BlobService`).
7. **Open a PR** using the template. Fill in all sections.

## Commit Messages

- Imperative mood, sentence case, <= 72 chars for the subject.
- Body explains **why**, not just **what**, when non-obvious.
- If the commit was authored with AI assistance, include this trailer:

  ```
  Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
  ```

## Pull Requests

- Keep PRs focused - one logical change per PR.
- Link the relevant issue or spec section.
- Update `DESIGN_SPEC.md` in the same PR if behavior or architecture changes.
- CI (lint, test, build for both frontend and Functions) must be green.
- At least one review approval required before merge.

## Security & Privacy

- Never commit secrets, tokens, or `.env` files. Use SWA/Functions app settings
  and Key Vault references.
- Never log or transmit clipboard or editor contents beyond what a feature
  requires. Clipboard/file reads are client-side only.
- Enforce spec limits (1 MB saved blob, 5 MB upload, 100-blob cap) on both
  client and server.
- Validate and authenticate every mutating API route with an Entra External ID-issued JWT.

## Reporting Issues

- Bug reports: include repro steps, expected vs. actual, browser/OS, and a
  minimal JSON sample if relevant. **Do not paste sensitive JSON.**
- Feature requests: describe the user problem first, then the proposed
  solution. Reference the spec section it would live in.

## Code of Conduct

Be respectful and constructive. Assume good intent. Disagree with ideas, not
people.
