# SW migration post-merge runbook

PR: TBD (link added post-merge)

**Owner**: @geevensingh (the PR author).

## Background

This migration replaced `@angular/service-worker` with a minimal
pass-through SW (`src/sw.worker.ts` -> `dist/jotjson/browser/sw.js`,
also written to `dist/jotjson/browser/ngsw-worker.js` as a
**permanent passthrough alias** so the pre-migration ngsw cohort
unsticks via its periodic `/ngsw-worker.js` byte-revalidation).

The new SW does nothing except (a) satisfy Chromium's PWA
installability check and (b) wipe legacy `@angular/service-worker`
caches on first activate. Update delivery is implicit on next
navigation (`no-cache, must-revalidate` on `index.html` + hashed
asset filenames + cache-wipe on activate).

See `DESIGN_SPEC.md` PWA section and `plan.md` in the original PR
for the full architectural decision and the 5 rubber-duck panels
that landed it.

## Single-maintainer fallback

The active-monitoring schedule below assumes @geevensingh is
available within hours of merge. If unavailable for >48h
post-deploy, the Bicep-deployed alert
(`alert-${namePrefix}-sw-migration-stuck-cohort` in
`infra/modules/alerts.bicep`) is the sole forcing function -- and
that is accepted. The active monitoring is a safety belt, not a
primary mechanism.

When a second code-owner joins the repo (`AGENTS.md` §8 Phase-2
tripwire), the owner of this runbook becomes a shared list.

## Cutover backfill (one-shot, post-merge)

The plan ships with placeholder `let cutoverBuildNumber = 999999999;`
in both:

1. `infra/workbooks/sw-migration.json` (workbook tile)
2. `infra/modules/alerts.bicep` resource
   `alert-${namePrefix}-sw-migration-stuck-cohort`

The placeholder is the **LOUD fail-safe direction**: every
session lands in `'pre'` (dashboard shows 0% post-migration
the day after we ship; obviously wrong), AND the alert fires
on every session (operator cannot miss it). After PR
squash-merge lands on `main`, run:

```sh
git fetch origin main
git rev-list --count origin/main
# -> N
```

Then edit both files, replace `999999999` with `<N>`, and commit
as a one-file follow-up PR. The follow-up PR is eligible for
proactive auto-merge per `AGENTS.md` §8 (infra/docs change, no
`dependencies` or `devDependencies` touched, no `src/`
touched). `infra.yml`'s `what-if` gate validates the Bicep
diff.

## Observation schedule (active monitoring, owner-driven)

| Window | Owner action |
| --- | --- |
| +6h    | First check. Run the workbook's era-distribution tile. Expected: `sw.legacyCacheWiped > 0` AND `sw.registerFailed` filtered to `reason=syntax` is `0`. If either fails, **same-day rollback** per Phase 6 of the original plan (the migration broke for a browser/CDN combination the e2e missed). |
| +24h   | Run workbook. Expected: <10% sessions in `pre`. Document result in this section. |
| +48h   | Re-run. Expected: <2% in `pre`. If >5%, file a `priority:high` incident issue with the cohort breakdown (browser/os buckets via `sw.legacyCacheWiped`). |
| +7d    | Final check. Expected: <0.5% in `pre`. Sunset the active monitoring (delete this checklist; the Bicep-deployed alert remains). |

### Operator caveats when reading the curves

- **Stuck users may take TWO clean cycles** before they appear in
  the `sw.activated` dashboard. The first cycle delivers NEW SW
  bytes via `/ngsw-worker.js` byte-revalidation while the page is
  still running OLD `main.ts` (cached HTML); OLD `main.ts` does not
  fire `sw.activated`. The next navigation loads NEW `main.ts`
  which calls `register('/sw.js')`; bytes are byte-identical so
  the install/activate is a no-op (no statechange re-fires). The
  page may need a third navigation before the state machine fires
  `sw.activated` cleanly. Do not misread the slow climb as
  "migration broken".
- **`sw.legacyCacheWiped` undercounts the single-visit cohort**.
  Users who open jotjson.com once, get unstuck, and never return
  will have the sentinel sit in IDB indefinitely; the event never
  fires. Acceptable -- those users are unstuck even though we do
  not see them in the dashboard.
- **`/ngsw.json` 200 responses are expected for the legacy cohort
  for the lifetime of the alias.** The pre-migration ngsw polls
  this URL on every navigation; we serve a `{}` stub. A spike
  in `/ngsw.json` request volume is not a regression -- it is
  the cohort behaving exactly as designed.

## Sunset criteria

Active monitoring sunsets when all three are true:
1. +7d query shows <0.5% pre.
2. No alert has fired since merge.
3. No incident issue has been opened citing SW state.

The Bicep-deployed scheduled alert remains in place indefinitely
(no per-resource cost in Log Analytics; it inherits the existing
action group). It is the persistent forcing function that
catches the same class of regression next time.

## Annual re-evaluation (12-month cadence)

The recurring-issues workflow at
`.github/workflows/recurring-issues.yml` re-opens an issue
labelled `sw-migration-cadence` every January 15 if no open
instance exists. The checklist on that issue includes:

- Chromium release notes since last check (filter for "service
  worker", "PWA install", "installability").
- SWA platform updates since last check (filter for "routes",
  "limits", "caching").
- Open security advisories matching our minimal SW pattern
  (e.g., a CVE in `clients.claim()` semantics).
- Reconfirm `priority:low` follow-up issue from `DESIGN_SPEC.md`
  PWA Decision log still represents the right re-evaluation
  question.
- `/ngsw.json` poll-volume check on Azure Front Door access logs.
  If <10 sessions/quarter, the OLD ngsw cohort has effectively
  drained and the `/ngsw-worker.js` alias can retire in the same
  PR as the `/ngsw.json` stub.

If the poll-volume check trips, follow Phase 7 of the original
plan: remove the alias from `scripts/sw-urls.mjs`
(`SW_LEGACY_ALIAS_URLS`), remove the second write target from
`scripts/build-sw.mjs`, remove the `/ngsw-worker.js` route from
`staticwebapp.config.json`, and add a one-line history entry
under `DESIGN_SPEC.md` -> Versioning.
