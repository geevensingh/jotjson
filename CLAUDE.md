# Claude Code Instructions - JotJSON

The authoritative instructions for this repository are in
[`AGENTS.md`](AGENTS.md). Read it and [`DESIGN_SPEC.md`](DESIGN_SPEC.md) before
making any non-trivial change. The summary below is for quick reference only;
`AGENTS.md` wins on any conflict.

## Non-negotiables

- `DESIGN_SPEC.md` is the product & architecture source of truth.
- Stack: Angular (latest LTS, standalone + Signals + Material), Azure Functions
  in TypeScript, Cosmos DB serverless, Azure Static Web Apps, Bicep in `/infra`.
- Use `jsonc-parser` for user JSON/JSONC - never `JSON.parse`.
- Strict TypeScript; no `any`; prefer `unknown` + narrowing.
- Standalone Angular components, `OnPush`, `inject()`, Signals, RxJS only at
  I/O boundaries. Kebab-case filenames; co-located `*.spec.ts`.
- Azure Functions: thin handlers, zod-validated inputs, Entra External ID JWT
  auth, typed
  JSON responses.

## Workflow

- Make surgical, fully-correct changes. Don't touch unrelated code.
- Add/update tests for every logic change.
- Before done: `npm run lint`, `npm test`, `npm run build` pass for frontend
  and `api/`. Don't introduce new toolchains to satisfy this.
- Update `DESIGN_SPEC.md` in the same change when behavior or architecture
  changes.

## Security & Privacy

- Never log or transmit clipboard/editor contents or PII.
- No secrets in source - use SWA/Functions app settings + Key Vault.
- Enforce spec limits on both client and server.
- Use Angular interpolation/binding over `innerHTML`.

## Commits

- Small, focused, imperative subject lines.
- AI-assisted commits include:
  `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`

## When Unsure

Ask a clarifying question rather than guessing on defaults, limits, scope, or
behavior. Prefer the simpler, spec-aligned option.
