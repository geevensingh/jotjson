# GitHub Copilot Instructions

The default coding instructions for this repository live in
[`AGENTS.md`](../AGENTS.md) at the repo root. Follow those in full for every
task - they cover the tech stack, project layout, coding conventions, testing,
security, and Definition of Done.

Key points (see `AGENTS.md` for the authoritative version):

- `DESIGN_SPEC.md` is the source of truth for product and architecture.
- Stack: Angular (latest LTS) + Angular Material + Signals; Azure Functions in
  TypeScript; Cosmos DB (serverless); Azure Static Web Apps; Bicep for IaC.
- Use `jsonc-parser` (not `JSON.parse`) for user JSON/JSONC input.
- Standalone Angular components, `OnPush`, `inject()`, strict TypeScript.
- Tests are required for logic changes. Run lint + test + build before done.
- No new frameworks, languages, or cloud services without approval.
- Never log or transmit clipboard/editor contents or secrets.
