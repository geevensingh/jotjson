# Security Policy

JotJSON is a small, hosted side project. We take security reports
seriously and appreciate responsible disclosure.

## Supported versions

JotJSON is a hosted application; only the latest deployed `main` is
supported. There are no released library versions to back-port fixes
to. The deployed app lives at <https://jotjson.com>.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's Private
Vulnerability Reporting:

<https://github.com/geevensingh/jotjson/security/advisories/new>

**Do not** open a public issue, public pull request, or discussion
thread for security reports. Please also do not paste working
exploits into any public channel before a fix is in place.

When you submit a report, include:

- A description of the issue and its impact.
- Steps to reproduce, including URLs, payloads, and request /
  response details where relevant.
- The affected component (frontend route, API route, infra resource).
- Your contact info for follow-up.

## Response expectations

This project is maintained on a best-effort basis. Our targets are:

- Acknowledge new reports within roughly **5 business days**.
- Provide an initial assessment (accept, request more info, or decline
  with reason) within roughly **10 business days**.
- Coordinate disclosure timing with the reporter once a fix is in
  flight.

We do **not** run a paid bug bounty program.

## Scope

### In scope

- The deployed application at <https://jotjson.com>.
- Source code in this repository: the Angular frontend (`src/`), the
  Azure Functions backend (`api/`), and the Bicep infrastructure
  (`infra/`).

### Out of scope

- Third-party services and platforms we depend on. Report issues in
  those directly to their vendors:
  - Microsoft Entra External ID, Azure Static Web Apps, Azure
    Functions runtime, Azure Cosmos DB, Application Insights,
    Microsoft Graph, MSAL libraries, Monaco Editor.
- Automated scanner output without a demonstrated real-world impact
  (for example, "tool X says header Y is missing" without an
  exploit chain).
- Denial-of-service, volumetric, brute-force, or rate-limit-bypass
  testing.
- Social engineering of maintainers or users.
- Physical attacks against infrastructure or devices.
- Missing or differently-configured security headers without a
  concrete exploit path. The headers we do set, including the CSP,
  are documented in `DESIGN_SPEC.md` -> Security and are kept in
  `staticwebapp.config.json`.
- Self-XSS that requires a victim to paste attacker-supplied content
  into their own browser, and clickjacking on pages with no
  state-changing actions.
- Findings that depend on already-compromised user devices, browser
  extensions, or the user disabling browser security features.

If you are unsure whether something is in scope, file the report
through PVR and ask. We would rather triage and decline than miss a
real issue.

## Safe harbor

If you make a good-faith effort to comply with this policy during
your research, we will not pursue or support legal action against
you.

To stay within "good faith", please:

- Do not access, modify, or exfiltrate other users' data beyond the
  minimum needed to demonstrate the issue.
- Do not run automated scanning or load testing that degrades the
  service for other users.
- Give us a reasonable window to respond before any public
  disclosure.

## Threat model

For the deployed threat model (authentication, response headers,
Content Security Policy, input handling, size and rate limits, and
the public-vs-authenticated routes), see `DESIGN_SPEC.md` ->
Security and the surrounding non-functional requirements section.
That document is the source of truth for what JotJSON is and is not
designed to defend against.
