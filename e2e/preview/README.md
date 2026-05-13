# JotJSON e2e - preview-env specs

This directory holds Playwright specs that **only make sense against a
deployed environment** (a real Azure Static Web Apps host, typically the
per-PR preview env on `swa-jotjson-nonprod`). They are skipped when the
suite is run against the local `dist/` serve.

## What lives here

- **`security-headers.spec.ts`** - asserts that the SWA-applied response
  headers from `staticwebapp.config.json` `globalHeaders` reach the
  browser on a request to `/`. Catches deploy-pipeline regressions
  (config drift, AFD stripping, CDN edge rewrites) that the
  `lint:swa-config` gate cannot catch by reading the source file alone.

## Why a separate folder

The `e2e/anonymous/` smoke specs validate **app behavior** - Monaco
mount, tree render, draft persistence, accessibility - and run against
both the local `dist/` serve and (in cd-preview) a deployed preview
URL. They pass either way.

The specs here validate **deploy behavior** - bytes the SWA platform
adds to responses, which only exist on a deployed host. Running them
against `localhost:4173` would always fail (or, worse, silently pass
against a `serve --single`-shaped response that does not include
`globalHeaders`). The skip-on-local-serve guard at the top of each
spec keeps the `e2e` CI job green when `PLAYWRIGHT_BASE_URL` is unset.

## Adding a spec here

1. Confirm the assertion only makes sense against a deployed SWA host.
   App-behavior specs belong in `e2e/anonymous/`.
2. Skip at module load when `PLAYWRIGHT_BASE_URL` is unset (see
   `security-headers.spec.ts` for the pattern). Specs in this folder
   must never fail when the suite runs against the local serve.
3. Keep the assertion narrow - one HTTP request per spec where
   feasible. cd-preview's `e2e-preview` job runs serially after the
   anonymous smoke; every spec here adds to total CI wall-time.

## Where these specs run

- **CI `e2e` job** (`ci.yml`, every push/PR): `PLAYWRIGHT_BASE_URL`
  unset; specs in this folder skip cleanly.
- **`cd-preview.yml` `e2e-preview` job** (per-PR preview deploys):
  `PLAYWRIGHT_BASE_URL=<preview-url>` set; specs in this folder run
  against the deployed preview environment.

See the top-level [`e2e/README.md`](../README.md) for the broader
suite layout, zero-flake norm, and CI integration overview.
