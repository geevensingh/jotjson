# GitHub Copilot Instructions

The default coding instructions for this repository live in
[`AGENTS.md`](../AGENTS.md) at the repo root. Follow it in full for every
task -- it covers the tech stack, project layout, coding conventions,
testing, security, and Definition of Done.

## Copilot CLI Specifics

When `AGENTS.md` §11 calls for parallel sub-agent execution, use `/fleet` mode
whenever possible -- especially when implementing an approved plan. Apply it
on every wave of the plan's dependency graph, not just the first one.
