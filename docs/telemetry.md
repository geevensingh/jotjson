# Telemetry & Logging Guide

How telemetry is wired up in jotjson, where the data ends up, and how to view
or query it during development and after deployment.

## Architecture overview

Two separate pipelines feed the same Application Insights resource:

```
Frontend (Angular SPA)
  call site --> LoggerService --> TelemetryService --> @microsoft/applicationinsights-web
                    |
                    +--> console.info / .warn / .error  (always, for DevTools)

Backend (Azure Functions)
  context.log / unhandled errors --> Functions runtime --> Application Insights
                                       (auto: requests / dependencies / exceptions)
  trackEvent(name, props, measurements) --> applicationinsights TelemetryClient --> Application Insights
                                       (manual customEvents from api/src/shared/telemetry.ts)

Application Insights resource (Azure)
  appi-<resourceSuffix>            <-- classic AI schema:  traces, exceptions, ...
        |
        +--> Log Analytics workspace
             appi-<resourceSuffix>-law  <-- LAW schema:  AppTraces, AppExceptions, ...
```

Source pointers:

- `src/app/core/telemetry/logger.service.ts` -- public facade. All app code
  calls `logger.info/warn/error(messageId, props)` here.
- `src/app/core/telemetry/telemetry.service.ts` -- thin wrapper around the
  App Insights SDK. The SDK is dynamically imported on first `connect()` to
  keep it out of the eager bundle.
- `src/app/core/telemetry/route-tracker.ts` -- emits manual `pageView`
  envelopes on router navigations.
- `src/app/core/telemetry/error-handler.ts` -- Angular `ErrorHandler` that
  forwards to `LoggerService.error`.
- `src/app/core/telemetry/msal-bridge.ts` -- routes MSAL auth errors into
  `LoggerService.error('msal.error', ...)`.
- `src/app/core/telemetry/normalize-error.ts` -- converts unknown throws
  and `HttpErrorResponse` instances into a stable shape; sanitizes URLs
  to path templates.
- `src/app/core/telemetry/redact-pii.ts` -- additional PII scrubbing helpers.
- `src/app/core/telemetry/telemetry-message-ids.ts` -- the canonical set of
  `messageId` literal-type identifiers (event/trace/exception names).
- `infra/modules/appInsights.bicep` -- provisions the App Insights component
  and its backing Log Analytics workspace (30-day retention).
- `infra/main.bicep` -- wires `APPLICATIONINSIGHTS_CONNECTION_STRING` into
  the Functions app settings, so backend auto-instrumentation just works.

## Privacy contract (important)

`TelemetryService` installs a privacy initializer
(`telemetry.service.ts:167-207`) on every envelope before it ships:

- URLs are reduced to path templates -- query strings and fragments are
  stripped via `sanitizePath`.
- Any envelope still containing `?` after sanitization is **dropped**, not
  shipped (defensive belt-and-braces).
- An `Authorization` header that somehow surfaces in custom dimensions is
  redacted to `<redacted>`.
- Cookies are disabled (`disableCookiesUsage: true`), so anonymous users
  cannot be cross-correlated across sessions; only authenticated users
  (correlated by Entra OID via `setAuthenticatedUserContext`) can.
- `disableExceptionTracking: true` -- the SDK's window.onerror / unhandled
  rejection auto-capture is **off**. We send exceptions explicitly through
  `LoggerService.error` so we control what is reported.
- `enableAutoRouteTracking: false` -- pageViews are emitted manually by
  `RouteTracker`, after sanitization.

If a query you expect to see is missing rows, the privacy initializer
dropping a `?`-containing envelope is one likely cause.

## Tables populated by jotjson

Classic AI schema (App Insights resource):

| Table | Source |
|---|---|
| `traces` | `LoggerService.info/warn` (severity 1/2) |
| `customEvents` | Frontend product events via `LoggerService.event` (`pref.changed`, `toolbar.action`, `webVitals`, `paste.handle`, `share.created`, `auth.signedIn`, etc.) and backend events via `trackEvent` in `api/src/shared/telemetry.ts` (`auth.tokenAccepted`, `auth.tokenRejected`, `access.forbidden`, `quota.exceeded`). |
| `exceptions` | `LoggerService.error` and `TelemetryErrorHandler` and replayed `boot.failed` envelopes |
| `pageViews` | `RouteTracker` on each navigation |
| `dependencies` | Auto-instrumented browser fetch/XHR (`disableAjaxTracking: false`); also outgoing calls from Functions |
| `requests` | Auto-instrumented Function invocations |

LAW schema (Log Analytics workspace) -- same data, different table names:

| Classic AI | LAW |
|---|---|
| `traces` | `AppTraces` |
| `customEvents` | `AppEvents` |
| `exceptions` | `AppExceptions` |
| `pageViews` | `AppPageViews` |
| `dependencies` | `AppDependencies` |
| `requests` | `AppRequests` |

The KQL examples below use the classic AI schema. To run them against the
LAW directly, swap the table name and rename `timestamp` to `TimeGenerated`.

---

## Sinks: trace vs event vs exception

`LoggerService` routes to three distinct Application Insights tables based
on which method you call. Pick the right method up front - migrating a
token between tables later creates a historical discontinuity.

| Method | Sink (classic AI table) | LAW table | When to use |
|---|---|---|---|
| `logger.info(id, props?)` | `traces` (severity 1) | `AppTraces` | Diagnostic / lifecycle log lines for humans reading logs. Low value individually. |
| `logger.warn(id, props?)` | `traces` (severity 2) | `AppTraces` | Recoverable problems that warrant attention but didn't fail the operation. |
| `logger.error(id, cause, props?)` | `exceptions` | `AppExceptions` | Unexpected failures. `cause` is normalized via `normalizeError`; the call also surfaces a stack trace. |
| `logger.event(id, props?, measurements?)` | `customEvents` | `AppEvents` | Successful product-analytics signals (counters, completed user actions, performance samples). Supports a numeric `measurements` map. |

The `props` map lands in `customDimensions` (string-keyed). The `event`
method's `measurements` map lands in `customMeasurements` (numeric,
queryable with `percentile()` / `avg()` / `sum()` / `min()` / `max()`).
Don't reuse the same key across both maps for the same event - the
wire format treats them as a single name-space.

Concrete event example: `webVitals` uses the `event` sink to record Core
Web Vitals as numeric measurements, while keeping its only dimension to
`appVersion`. See [Web Vitals](#web-vitals) for the full contract.

A common pattern is to include the raw number as a measurement AND a
pre-bucketed label as a dimension, so the same event answers both
"distribution shape" and "group-by bucket" queries:

```ts
import { bucketBytes } from 'src/app/core/telemetry/buckets';
logger.event(
  'paste.handle',
  { sizeBytesBucket: bucketBytes(text.length), parseSuccess: true },
  { sizeBytes: text.length, parseMs: 12 }
);
```

```kusto
// distribution shape
customEvents
| where name == 'paste.handle'
| summarize percentiles(toreal(customMeasurements.parseMs), 50, 95, 99)
// group-by bucket
customEvents
| where name == 'paste.handle'
| summarize count() by tostring(customDimensions.sizeBytesBucket)
```

---

## Bucketing conventions

`customDimensions` is high-volume, immutable, indexed, and billed.
High-cardinality values (raw byte counts, raw colors, full URLs, free
search text) are forbidden. Use the helpers in
`src/app/core/telemetry/buckets.ts`:

| Helper | Returns | Buckets |
|---|---|---|
| `bucketBytes(n)` | `SizeBucket` | `<1KB`, `1-10KB`, `10-100KB`, `100KB-1MB`, `>1MB` |
| `bucketCount(n)` | `CountBucket` | `<100`, `100-1K`, `1K-10K`, `>10K` |

For other dimensional facets, prefer hand-coded closed-enum strings
(e.g. `visibility: 'public' | 'private'`, `theme: 'light' | 'dark' |
'system'`). Booleans serialize as `'true'` / `'false'` and are fine.
Color values use a coarse named bucket
(`'red' | 'orange' | ... | 'gray' | 'custom'`) plus an `isDefault`
boolean - never the raw hex.

`webVitals` is the only current event that sends `appVersion` as a raw
string dimension. Like `app.boot`, it is exempt from the closed-enum
cardinality rule because it has one value per deploy (roughly one per
week), not one value per user action or payload.

---

## Web Vitals

`webVitals` records Google's Core Web Vitals - Largest Contentful Paint
(LCP), Interaction to Next Paint (INP), and Cumulative Layout Shift (CLS)
- because they are the user-perceived performance signals that move SEO
and UX needles.

The implementation uses the `web-vitals` npm package through a lazy-loaded
telemetry module. Both the package and the wrapper module land in their own
JavaScript chunk, fetched after `app.boot`; nothing from this path is part
of the initial bundle.

The event is emitted once per page lifecycle on the first `pagehide` event
with `{ once: true }`. BFCache resumes do not re-emit the event; that is an
accepted gap unless BFCache traffic becomes interesting enough to analyze
separately. If all metrics are still undefined at `pagehide`, no event is
emitted because an empty `webVitals` event is noise.

Measurements are optional, and undefined keys are omitted:

- `lcpMs` - Largest Contentful Paint in milliseconds. It typically reports
  near `pagehide`, after the largest content paint has stabilized. Hidden-tab
  loads can emit early.
- `inpMs` - Interaction to Next Paint in milliseconds. This replaces FID and
  remains undefined for sessions with zero interactions.
- `cls` - Cumulative Layout Shift as a unitless score, not milliseconds. The
  CLS window closes when the document becomes hidden; the package handles
  that behavior and JotJSON snapshots the value.

Privacy posture: the only custom dimension is `appVersion` from
`BUILD_INFO.version`. No URLs, user IDs, editor or clipboard text, or other
payload content are attached.

---

## Backend events

Manual `customEvents` emitted from Azure Functions via the
`trackEvent` helper in `api/src/shared/telemetry.ts`. The Functions
runtime separately auto-instruments `requests` / `dependencies` /
`exceptions`, but those pipelines do not produce `customEvents`;
this section is exclusively about the four explicit events.

The manual `TelemetryClient` is constructed lazily on first call,
reads `APPLICATIONINSIGHTS_CONNECTION_STRING` from app settings, and
becomes a permanent no-op after a one-shot `console.warn` if the
connection string is missing. `useGlobalProviders: false` keeps it
isolated from the host's OpenTelemetry providers.

All four events run after `requireAuth`, so `authMode` reflects
which auth gate the call passed (or for `auth.tokenRejected` was
rejected by). Properties land in `customDimensions`; numeric data
lands in `customMeasurements`.

### Event catalog

| Event | Source | Properties | Measurements |
|---|---|---|---|
| `auth.tokenAccepted` | `requireAuth` / `optionalAuth` in `api/src/shared/auth.ts` | `{authMode: 'required' \| 'optional'}` | none |
| `auth.tokenRejected` | `requireAuth` in `api/src/shared/auth.ts` | `{reason, authMode: 'required'}` where `reason` is one of `missing_bearer`, `malformed`, `invalid_signature`, `expired`, `wrong_audience`, `wrong_issuer`, `no_kid` | none |
| `access.forbidden` | `forbidden()` helper in `api/src/shared/http.ts` | `{resource: 'blob' \| 'ruleSet', authMode: 'required'}` | none |
| `quota.exceeded` | `quotaExceeded()` helper in `api/src/shared/http.ts` | `{resource: 'blob' \| 'ruleSet', authMode: 'required', via: 'create' \| 'clone'}` | `{count, limit}` |

Notes:

- `auth.tokenAccepted` fires for both `required` and `optional` auth
  paths. `auth.tokenRejected` only fires on `required`; bad tokens
  on `optional` paths fall through as anonymous and emit nothing.
- `access.forbidden` only emits via the `forbidden()` helper. A
  handler that returns a hand-rolled 403 will not emit (none do
  today).
- `quota.exceeded` is **only** emitted on the manual-strategy 409
  path. The `postBlob` `strategy = 'auto_fifo'` path silently
  evicts the oldest blob and does NOT emit.
- `count` is the raw current count (not clamped to `limit`) so
  reductions in `limit` and historical overages remain queryable.

No user content, blob bodies, slugs, rule-set ids, or free-form
strings are emitted from any backend event. Every dimension is a
closed enum or a bounded counter.

### KQL examples

```kusto
// Auth funnel: required vs optional, accepted vs rejected.
customEvents
| where name in ('auth.tokenAccepted', 'auth.tokenRejected')
| summarize count() by name,
    authMode = tostring(customDimensions.authMode),
    reason = tostring(customDimensions.reason)
| order by name asc, authMode asc, reason asc
```

```kusto
// Forbidden access by resource type, last 7 days.
customEvents
| where timestamp > ago(7d)
| where name == 'access.forbidden'
| summarize count() by resource = tostring(customDimensions.resource)
```

```kusto
// Quota events with the count vs limit gap, last 30 days.
customEvents
| where timestamp > ago(30d)
| where name == 'quota.exceeded'
| extend
    count_ = toreal(customMeasurements.count),
    limit_ = toreal(customMeasurements.limit)
| project timestamp, customDimensions, count_, limit_, gap = count_ - limit_
| order by timestamp desc
```

```kusto
// Schema drift guard: any unexpected property keys in the four
// backend events? (Catches accidental new dimensions early.)
customEvents
| where name in ('auth.tokenAccepted', 'auth.tokenRejected',
                  'access.forbidden', 'quota.exceeded')
| extend keys = bag_keys(customDimensions)
| mv-expand key = keys to typeof(string)
| summarize count() by name, key
| order by name asc, key asc
```

---

## Frontend events

Manual `customEvents` emitted from the Angular frontend via
`LoggerService.event(id, props?, measurements?)`. All frontend events
land in the `customEvents` (classic AI) / `AppEvents` (LAW) table.

### Event catalog

#### `tree.expand.autoFit`

**Kind:** event   **Level:** info   **Cold flag:** no   **Sampling:** 100% (unsampled)

Fired every time the auto-fit algorithm successfully picks an initial
expansion depth and applies it. Specifically: the user has
`treeAutoFitToWindow` on, the viewport is measurable (capacity >= 1
and probe row height >= 8 px), and `expandToLevel(K, internal=true)`
has been called.

**Properties:** none (no closed-enum bag means no schema constraints
to maintain).

**Measurements:**

| name | type | meaning |
| --- | --- | --- |
| chosenDepth | number | The picked K (root = 0). |
| totalNodes | number | Total nodes in the tree (all depths). |
| viewportPx | number | The scroll container's clientHeight at measurement time. |
| probeRowPx | number | Measured height of the hidden probe row (lower bound on row height). |
| estimatedRows | number | floor(viewportPx / probeRowPx) - the row capacity used in the algorithm. |
| chosenRows | number | sum(nodesAt[0..chosenDepth]) - the estimated rows that will be visible. |
| fillRatioPct | number | round(chosenRows / estimatedRows * 100). Estimated fill (probe-based). |
| actualHeightPx | number | Post-expand scroll container scrollHeight (real rendered height). |
| actualFillRatioPct | number | round(actualHeightPx / viewportPx * 100). Real fill. |

**Example: distribution of actual fill ratio**

To tune the 1.5x overflow tolerance, examine how often the algorithm
overfills:

```kusto
customEvents
| where name == "tree.expand.autoFit"
| extend
    actualFillRatioPct = toint(customMeasurements.actualFillRatioPct),
    chosenDepth = toint(customMeasurements.chosenDepth)
| summarize p50 = percentile(actualFillRatioPct, 50),
            p90 = percentile(actualFillRatioPct, 90),
            p99 = percentile(actualFillRatioPct, 99),
            count_ = count()
        by chosenDepth
| order by chosenDepth asc
```

If p90 or p99 is consistently > 200%, the tolerance is too aggressive
and we should consider reducing it or adding a corrective
measure-after-expand pass.

#### `tree.decoded.click`

**Kind:** event   **Level:** info   **Cold flag:** no   **Sampling:** 100% (unsampled)

Fired every time the user toggles the per-row "decoded view" pill on a
string leaf. Toggling on AND off both emit one event each. Display-only
toggle: does not mutate the value, copy text, search results, or any
persisted state. The event lets us see how often the affordance is
used and at what payload size, without ever logging the string itself.

**Properties:**

| name | type | values |
| --- | --- | --- |
| source | string | `rowButton` (clicked the pill) or `contextMenu` (clicked the kebab-menu item). |
| direction | string | `on` (entered the decoded view) or `off` (returned to the JSON-escaped view). |
| lineCountBucket | string | Bucketed line count of the string at click time: `1`, `2-5`, `6-20`, `21-100`, `100+`. CRLF counts as one line break. |

**Measurements:** none (line count is reported as a closed-enum bucket
in `lineCountBucket` to keep the schema small).

**Example: split between row pill and context menu**

```kusto
customEvents
| where name == "tree.decoded.click"
| summarize count() by tostring(customDimensions.source)
```

#### `blob.coldBoot.firstPaint`

**Kind:** event   **Level:** info   **Cold flag:** yes (one-shot per cold-boot blob nav)   **Sampling:** 100% (unsampled)

Fired exactly once per session, after the loading splash's
"Rendering tree..." stage clears on a cold-boot deep-link to
`/s/:slug`. Measures the gap between the share-blob `NavigationEnd`
and the first browser paint that includes the rendered tree, deferred
through `afterNextRender` plus a double-`requestAnimationFrame` paint
barrier in `HomeComponent`. Lets us see how long users actually stare
at the "Rendering tree..." label and prioritize incremental tree
rendering if the distribution warrants it.

Naturally bounded: only the cold-boot first-nav blob NavigationEnd
sets `renderPending=true`. The `firstNavComplete` latch prevents
in-app `/` -> `/s/:slug` navs from re-arming the stage, and
`markBlobRenderComplete` short-circuits when `renderPending` is
already false (so re-instantiating `HomeComponent` for in-app navs
never double-counts).

**Properties:** none.

**Measurements:**

| name | type | meaning |
| --- | --- | --- |
| durationMs | number | `performance.now()` delta from the cold-boot blob `NavigationEnd` to the moment the inner-rAF callback fires `markBlobRenderComplete`. Raw value, no bucket dimension - distribution percentiles derive in KQL. |

**Example: render-pending duration distribution**

```kusto
customEvents
| where name == "blob.coldBoot.firstPaint"
| extend durationMs = todouble(customMeasurements.durationMs)
| summarize p50 = percentile(durationMs, 50),
            p90 = percentile(durationMs, 90),
            p99 = percentile(durationMs, 99),
            count_ = count()
```

---

## How to view the logs

### Local development

By default, no telemetry leaves your machine. `environment.example.ts` and
`environment.prod.ts` ship with `appInsightsConnectionString: ''`, and
`TelemetryService.connect()` short-circuits to `disabled` when the string
is empty (`telemetry.service.ts:66-71`).

- **Frontend** -- open browser **DevTools -> Console**. `LoggerService`
  mirrors every entry there as `[<messageId>] {props}`. This is the fast
  path during dev.
- **API** -- run `func start` (Azure Functions Core Tools) inside `api/`.
  `context.log/warn/error` lines appear on stdout.

### Sending local frontend logs to App Insights too (opt-in)

Useful for validating the full pipeline from your dev machine:

```sh
az functionapp config appsettings list -g <rg> -n <funcapp> \
  --query "[?name=='APPLICATIONINSIGHTS_CONNECTION_STRING'].value" -o tsv
```

Paste the value into `src/environments/environment.ts` as
`appInsightsConnectionString`, then restart `ng serve`. The SPA will ship
to the same AI resource the deployed app uses.

`environment.ts` is gitignored -- do **not** commit the connection string.

### Deployed app (Azure Portal)

Open the App Insights resource (`appi-<resourceSuffix>`). The four most
useful blades:

- **Live Metrics** -- last few minutes, real-time. Best for "is anything
  happening right now?"
- **Logs** -- KQL editor with autocomplete and a schema browser. Workhorse.
- **Failures** -- exceptions and failed requests with auto-grouping.
- **Performance** -- slowest operations / dependencies.
- **Application Map** -- topology view of SPA + Functions calling Cosmos /
  Storage.

For Function-specific debugging:

- **Function App -> Log stream** -- live tail of `context.log` stdout.
- **Function App -> Functions -> <fn> -> Monitor** -- per-invocation list,
  each row links into App Insights.

---

## Querying with Kusto-aware tools

App Insights and Log Analytics are real Azure Data Explorer (Kusto)
clusters under the hood, exposed through proxy endpoints. Any tool that
speaks KQL can connect.

### Proxy URLs (dev)

Two cluster URLs map to the same data; pick whichever schema you prefer.

App Insights (classic schema, `traces` / `exceptions` / `customEvents` / ...):

```
https://ade.applicationinsights.io/subscriptions/db5e75e4-b980-486d-a11e-fe9327a52031/resourcegroups/rg-jotjson-dev/providers/microsoft.insights/components/appi-jotjson-dev
```

Log Analytics workspace (App-prefixed schema, `AppTraces` / `AppExceptions` /
`AppEvents` / ...):

```
https://ade.loganalytics.io/subscriptions/db5e75e4-b980-486d-a11e-fe9327a52031/resourcegroups/rg-jotjson-dev/providers/microsoft.operationalinsights/workspaces/appi-jotjson-dev-law
```

To find the equivalent values for any new environment:

```sh
az login
az resource list --resource-type Microsoft.Insights/components \
  --query "[].{name:name, rg:resourceGroup, sub:subscriptionId}" -o table
az resource list --resource-type Microsoft.OperationalInsights/workspaces \
  --query "[].{name:name, rg:resourceGroup, sub:subscriptionId}" -o table
```

### Resources today

Concrete values for the only environment that exists right now (`dev`):

| Item | Value |
|---|---|
| Subscription | `db5e75e4-b980-486d-a11e-fe9327a52031` (JotJson Subscription) |
| Resource group | `rg-jotjson-dev` |
| App Insights component | `appi-jotjson-dev` |
| App Insights App ID (REST) | `44cc7a7c-8382-490f-8a99-7107fccfa1b0` |
| Log Analytics workspace | `appi-jotjson-dev-law` |
| LAW Workspace GUID (`customerId`) | `fdd8e231-1e9b-4fa9-921c-2c0ddf505e1b` |
| Entra tenant | `68fa6d3c-ab3e-4eea-97bb-f0376ea54cba` |

When `stg` and `prod` are stood up -- they follow the same naming, just swap
`-dev` for `-stg` or `-prod` in the resource group and resource names. None
of the IDs above are credentials; access still requires Entra sign-in with
**Reader** (or higher) on the resource.

### Option 1 -- Azure Data Explorer Web UI (recommended)

No install. Best free Kusto IDE. https://dataexplorer.azure.com

1. Click **Add Cluster** and paste either proxy URL above.
2. Sign in with the same Entra account you use for the Azure Portal.
3. The cluster appears in the left tree with the AI/LAW resource as the
   database; tables show up under it.
4. Open a query tab and run `traces | take 10`.

### Option 2 -- Kusto Explorer (Windows desktop)

Download from
https://learn.microsoft.com/azure/data-explorer/kusto/tools/kusto-explorer

1. **Add Connection** -> paste either proxy URL.
2. Auth via Entra (AAD).
3. Database appears in the connection tree.

Caveats: AI/LAW proxy clusters are query-only, so admin commands like
`.show cluster` and ingestion mappings don't apply. Pure KQL queries work.

### Option 3 -- VS Code "Kusto (KQL)" extension

Marketplace: `ms-kusto.kusto`.

1. `Ctrl+Shift+P` -> "Kusto: Add cluster connection" -> paste the proxy URL.
2. Author KQL in `.kql` files with IntelliSense; run inline.

Good fit if you want to check common queries into the repo
(e.g., a future `docs/queries/*.kql`).

### Option 4 -- Azure CLI (scriptable)

```sh
# AI side -- accepts the AI resource name when unambiguous
az monitor app-insights query \
  --app appi-jotjson-dev \
  --analytics-query "exceptions | order by timestamp desc | take 20" \
  -o table

# LAW side -- needs the workspace GUID (customerId)
az monitor log-analytics query \
  --workspace fdd8e231-1e9b-4fa9-921c-2c0ddf505e1b \
  --analytics-query "AppExceptions | order by TimeGenerated desc | take 20" \
  -o table
```

### Option 5 -- PowerShell

```powershell
# Requires Az.OperationalInsights
Invoke-AzOperationalInsightsQuery `
  -WorkspaceId "fdd8e231-1e9b-4fa9-921c-2c0ddf505e1b" `
  -Query "AppExceptions | take 20"
```

### Option 6 -- REST API

```
POST https://api.applicationinsights.io/v1/apps/44cc7a7c-8382-490f-8a99-7107fccfa1b0/query
Authorization: Bearer <Entra-token-with-AI-Reader>
Content-Type: application/json

{"query": "exceptions | order by timestamp desc | take 20"}
```

The path segment is the AI resource's **App ID** GUID (visible on the AI
overview blade as "Application ID"), not the Azure resource ID. The value
above is for `appi-jotjson-dev`.

### Cross-tenant gotcha (read this if "wrong issuer" hits you)

The JotJson subscription lives in the JotJson Entra tenant
(`68fa6d3c-ab3e-4eea-97bb-f0376ea54cba`). If you also have access to other
Entra directories (work, MSA / personal, customer tenants), most of these
tools default to whichever tenant your browser or CLI is currently signed
in to, which may not be JotJson's. The proxy cluster will then reject
your token with:

```
Failed to fetch schema: The access token is from the wrong issuer
'https://sts.windows.net/<other-tenant>/'. It must match the tenant
'https://sts.windows.net/68fa6d3c-ab3e-4eea-97bb-f0376ea54cba/'
associated with this subscription.
```

Fix per tool:

- **ADX Web UI** -- click your profile icon (top right) -> **Switch
  directory** -> pick the JotJson directory and reload. Or open the UI
  with an explicit tenant hint:

  ```
  https://dataexplorer.azure.com/?tenantId=68fa6d3c-ab3e-4eea-97bb-f0376ea54cba
  ```

- **Kusto Explorer (desktop)** -- in the **Add Connection** dialog set
  **AAD authority** / **Tenant** to
  `68fa6d3c-ab3e-4eea-97bb-f0376ea54cba`
  (or `https://login.microsoftonline.com/68fa6d3c-ab3e-4eea-97bb-f0376ea54cba`)
  before saving.

- **VS Code Kusto extension** -- run **Kusto: Sign Out**, then
  **Kusto: Sign In** and pick the JotJson account / tenant in the picker.

- **az CLI** --

  ```sh
  az login --tenant 68fa6d3c-ab3e-4eea-97bb-f0376ea54cba
  az account set --subscription db5e75e4-b980-486d-a11e-fe9327a52031
  ```

- **PowerShell (`Az`)** --

  ```powershell
  Connect-AzAccount -Tenant 68fa6d3c-ab3e-4eea-97bb-f0376ea54cba
  Set-AzContext -Subscription db5e75e4-b980-486d-a11e-fe9327a52031
  ```

- **REST** -- request the bearer token from
  `https://login.microsoftonline.com/68fa6d3c-ab3e-4eea-97bb-f0376ea54cba/oauth2/v2.0/token`
  with scope `https://api.applicationinsights.io/.default`.

---

## Starter KQL query catalog

Tested against the classic AI schema. For LAW, swap the table name (see
the mapping above) and rename `timestamp` to `TimeGenerated`.

### Web Vitals percentiles, last day

```kusto
customEvents
| where timestamp > ago(1d)
| where name == 'webVitals'
| extend lcp_ms = todouble(customMeasurements['lcpMs']),
         inp_ms = todouble(customMeasurements['inpMs']),
         cls    = todouble(customMeasurements['cls'])
| summarize
    lcp_p75 = percentile(lcp_ms, 75),
    inp_p75 = percentile(inp_ms, 75),
    cls_p75 = percentile(cls, 75),
    sessions = count()
  by app_version = tostring(customDimensions['appVersion'])
| sort by app_version desc
```

### Recent exceptions, last hour

```kusto
exceptions
| where timestamp > ago(1h)
| extend messageId = tostring(customDimensions.messageId)
| project timestamp, messageId, type, outerMessage, problemId, cloud_RoleName
| order by timestamp desc
```

### MSAL auth errors

```kusto
exceptions
| where customDimensions.messageId == "msal.error"
| project timestamp, outerMessage, customDimensions
| order by timestamp desc
| take 50
```

### App boot failures (replayed from sessionStorage on next load)

```kusto
exceptions
| where customDimensions.messageId == "boot.failed"
| project timestamp, outerMessage, customDimensions
| order by timestamp desc
```

### Slowest API dependencies, p95

```kusto
dependencies
| where timestamp > ago(24h)
| where type in ("Fetch", "Ajax", "Http")
| summarize p95 = percentile(duration, 95), count_=count() by name
| order by p95 desc
| take 20
```

### Functions request failures

```kusto
requests
| where timestamp > ago(24h)
| where success == false
| project timestamp, name, resultCode, duration, operation_Id, cloud_RoleName
| order by timestamp desc
| take 100
```

### Page navigations in the SPA, last hour

```kusto
pageViews
| where timestamp > ago(1h)
| project timestamp, name, url, duration, user_AuthenticatedId
| order by timestamp desc
```

### All telemetry for one signed-in user

Replace `<entra-oid>` with the user's Entra Object ID (set by
`TelemetryService.applyUser` -> `setAuthenticatedUserContext`).

```kusto
union customEvents, traces, exceptions, pageViews, dependencies
| where user_AuthenticatedId == "<entra-oid>"
| where timestamp > ago(7d)
| project timestamp, itemType, name, severityLevel, customDimensions
| order by timestamp desc
```

### Distribution of `messageId` over the last day

Use to confirm new instrumentation is firing.

```kusto
union traces, exceptions, customEvents
| where timestamp > ago(1d)
| extend messageId = tostring(customDimensions.messageId)
| where isnotempty(messageId)
| summarize count_=count() by messageId, itemType
| order by count_ desc
```

### Correlate a SPA page view with the Functions request it triggered

```kusto
let opId = "<operation_Id-from-pageView>";
union pageViews, dependencies, requests, traces, exceptions
| where operation_Id == opId
| project timestamp, itemType, name, target, duration, success
| order by timestamp asc
```

### Find the most common exception fingerprints

```kusto
exceptions
| where timestamp > ago(7d)
| summarize count_=count(), latest=max(timestamp) by problemId
| order by count_ desc
| take 25
```

---

## Gotchas

- **Local dev is console-only by default.** If you don't see logs in AI
  while running locally, that is expected. See "Sending local frontend
  logs to App Insights" above to opt in.
- **Ingestion latency.** Expect 30 s to 2 min before fresh events show up
  in `Logs`. Live Metrics is faster (~1 s) but ephemeral.
- **The privacy initializer drops envelopes containing `?`** in URI/name
  fields (`telemetry.service.ts:192-198`). If `dependencies` is missing
  rows for some endpoint, check that `sanitizePath` covers the URL shape.
- **30-day retention** on the LAW (`appInsights.bicep:11`). Older data is
  gone unless retention is bumped or data is archived.
- **Cookies disabled.** Cross-session correlation only works for signed-in
  users via `user_AuthenticatedId`.
- **The SDK is lazy-loaded.** Calls made before `LoggerService.connect()`
  are buffered (FIFO, cap 100 -- `logger.service.ts:15,114-118`) and
  replayed on connect. If telemetry cannot initialize at all, the buffer
  is dropped and the sink becomes a permanent no-op for that session.
- **Manual instrumentation only.** Don't expect SDK-auto-captured stack
  traces or unhandled-rejection envelopes. Everything in `exceptions`
  came through `LoggerService.error`.

---

## References

- [Application Insights overview](https://learn.microsoft.com/azure/azure-monitor/app/app-insights-overview)
- [KQL quick reference](https://learn.microsoft.com/azure/data-explorer/kql-quick-reference)
- [Azure Data Explorer Web UI](https://dataexplorer.azure.com)
- [Kusto Explorer (desktop)](https://learn.microsoft.com/azure/data-explorer/kusto/tools/kusto-explorer)
- [App Insights Classic vs Workspace schema mapping](https://learn.microsoft.com/azure/azure-monitor/app/convert-classic-resource#data-structure-changes)
- [`@microsoft/applicationinsights-web` SDK docs](https://learn.microsoft.com/azure/azure-monitor/app/javascript-sdk)

---

## Dashboards & alerts

### Quick links

Direct portal links to the resources backing the dashboards and alerts
described below. URLs include the JotJson tenant
(`68fa6d3c-ab3e-4eea-97bb-f0376ea54cba`) so the portal pins to the right
directory at sign-in.

- [Resource group `rg-jotjson-dev` (overview)](https://portal.azure.com/#@68fa6d3c-ab3e-4eea-97bb-f0376ea54cba/resource/subscriptions/db5e75e4-b980-486d-a11e-fe9327a52031/resourceGroups/rg-jotjson-dev/overview)
- [App Insights component `appi-jotjson-dev` (overview)](https://portal.azure.com/#@68fa6d3c-ab3e-4eea-97bb-f0376ea54cba/resource/subscriptions/db5e75e4-b980-486d-a11e-fe9327a52031/resourceGroups/rg-jotjson-dev/providers/microsoft.insights/components/appi-jotjson-dev/overview)
  -- entry point for Live Metrics, Failures, Performance, App Map, Logs.
- [App Insights -> Workbooks gallery](https://portal.azure.com/#@68fa6d3c-ab3e-4eea-97bb-f0376ea54cba/resource/subscriptions/db5e75e4-b980-486d-a11e-fe9327a52031/resourceGroups/rg-jotjson-dev/providers/microsoft.insights/components/appi-jotjson-dev/workbooks)
  -- open the workbook named **`JotJSON monitoring (dev)`**. (If the gallery
  subpath ever changes, fall back to the App Insights overview link above
  and click **Workbooks** in the left nav.)
- [Log Analytics workspace `appi-jotjson-dev-law` (overview)](https://portal.azure.com/#@68fa6d3c-ab3e-4eea-97bb-f0376ea54cba/resource/subscriptions/db5e75e4-b980-486d-a11e-fe9327a52031/resourceGroups/rg-jotjson-dev/providers/microsoft.operationalinsights/workspaces/appi-jotjson-dev-law/overview)
- [Log Analytics -> Alerts](https://portal.azure.com/#@68fa6d3c-ab3e-4eea-97bb-f0376ea54cba/resource/subscriptions/db5e75e4-b980-486d-a11e-fe9327a52031/resourceGroups/rg-jotjson-dev/providers/microsoft.operationalinsights/workspaces/appi-jotjson-dev-law/alerts)
  -- alerts blade scoped to the workspace. (Fallback: open the LAW overview
  link above and click **Alerts** in the left nav.)
- [Action group `ag-jotjson-dev` (overview)](https://portal.azure.com/#@68fa6d3c-ab3e-4eea-97bb-f0376ea54cba/resource/subscriptions/db5e75e4-b980-486d-a11e-fe9327a52031/resourceGroups/rg-jotjson-dev/providers/microsoft.insights/actionGroups/ag-jotjson-dev/overview)

If you hit a `wrong issuer` token error after sign-in, see
[Cross-tenant gotcha](#cross-tenant-gotcha-read-this-if-wrong-issuer-hits-you).

### Overview

An operator-facing monitoring layer sits on top of the instrumentation
documented earlier in this file: a workbook with five sections (Health,
Performance, Auth & Access, API, Quotas) and four scheduled-query-rule alerts
wired to a single action group.

The action group is wired to `jotjsonadmin@gmail.com` in
`infra/parameters/dev.bicepparam`. Override at deploy time by
passing a different `notificationEmail` parameter. Issue #94 (the
M7i follow-up to wire any receiver at all) is closed.

### Workbook vs alert schema split

The workbook and alerts intentionally query different Azure Monitor targets.
This is the easiest part to get wrong when editing these resources.

- **Workbook** queries target the App Insights component directly
  (`Microsoft.Insights/components`) and use the **classic** App Insights tables:
  `customEvents`, `requests`, `dependencies`, `exceptions`, `pageViews`,
  `traces`. Custom dimensions live under `customDimensions`, custom
  measurements under `customMeasurements`. Time column is `timestamp`. HTTP
  result code is `resultCode`. `success` is a boolean.
- **Alerts** (scheduled-query-rules) target the **Log Analytics workspace**
  (`Microsoft.OperationalInsights/workspaces`) and must use the **`App*`**
  schema: `AppEvents`, `AppRequests`, `AppDependencies`, `AppExceptions`,
  `AppPageViews`, `AppTraces`. Custom dimensions live under `Properties`,
  custom measurements under `Measurements`. Time column is `TimeGenerated`.
  HTTP result code is `ResultCode`. `Success` is a string (`"True"` /
  `"False"`).

Editing rule: if you copy a query from the workbook into an alert (or vice
versa), you **must** translate the table name, the custom-dimension column name,
the time column, and the case of the success/result-code columns. Mixing schemas
silently breaks evaluation; queries return 0 rows or fail.

### Workbook sections

- **Health** -- overall request volume / failure rate, top exception types,
  `app.boot` version distribution from `customDimensions.appVersion` on the
  `app.boot` event.
- **Performance** -- Web Vitals (`webVitals` event), `parse.slow` event volume,
  p50/p95 request duration.
- **Auth & Access** -- `auth.tokenAccepted` / `auth.tokenRejected` event split,
  rejection-reason breakdown.
- **API** -- Functions request rate, 4xx/5xx breakdown, p95 duration by
  operation.
- **Quotas** -- `quota.exceeded` event volume, top quota types.

### Alerts

- **boot.failed** -- detects any exception with
  `Properties.messageId == 'boot.failed'`. Threshold: `count > 0` over a
  15-minute window. Severity: 1. Indicates the SPA failed to boot
  (catastrophic). Tuning: none; this should always fire on the first occurrence.
- **app.unhandled** -- detects exceptions with
  `Properties.messageId == 'app.unhandled'`. Threshold: `count >= 5` over a
  15-minute window. Severity: 2. Tuning: issue #89 (dynamic thresholds).
- **fn-5xx** -- detects Functions 5xx absolute count. Threshold: `count >= 2`
  over a 15-minute window. Severity: 2. Tuning: issue #87 (convert to
  rate-based once traffic exists).
- **auth-config** -- detects the narrow `auth.tokenRejected` filter with
  `Properties.reason in ('wrong_audience', 'wrong_issuer')`. Threshold:
  `count > 0` over a 15-minute window. Severity: 1. Indicates token-validation
  config drift. Broader auth-rejection alert: issue #91.

### Alert query gotcha: row-based, not summarize-based

Scheduled-query-rule alerts use `timeAggregation: 'Count'`, which
counts the **rows the query returns**, not the value of an aggregate
column. KQL's `summarize` without a `by` clause always returns
exactly one row, so a query like:

```kql
AppRequests
| where ResultCode startswith '5'
| summarize count = count()
```

paired with `Count >= 2` is **unreachable** -- the row count is
always 1. The fix is to drop the `summarize` and let `Count` count
matching rows directly:

```kql
AppRequests
| where ResultCode startswith '5'
```

If you need to compare against an aggregate value instead of a row
count, set `timeAggregation: 'Total'` and `metricMeasureColumn:
'<column>'`. We don't currently use that pattern; see the 5/1
incident retrospective in commit history for context.

### Receivers (action group)

The action group is wired to `jotjsonadmin@gmail.com` for `dev` via
`infra/parameters/dev.bicepparam`. To override at deploy time:

```sh
az deployment group create \
  --resource-group rg-jotjson-dev \
  --template-file infra/main.bicep \
  --parameters infra/parameters/dev.bicepparam \
  --parameters notificationEmail=alerts@example.com
```

Equivalently, edit `infra/parameters/dev.bicepparam` to set a
different `notificationEmail` and let the `infra` workflow pick it up.

Issue #92 covers expanding to SMS / Teams / webhook receivers.

### Tuning thresholds

1. Open the workbook; pick a relevant section (for example, "API" for
   `fn-5xx`).
2. Look at the actual baseline rate over the last 7-30 days.
3. Edit the relevant alert resource in `infra/modules/alerts.bicep`. Update the
   `threshold` value or the underlying KQL.
4. Run `az bicep build --file infra/main.bicep` locally to validate.
5. Commit and push (pre-V1: direct-to-main; post-V1: PR).
6. The `infra.yml` workflow runs `az deployment group what-if` on push
   for sanity, then auto-deploys on success. `workflow_dispatch` is
   available as a manual redeploy override.

### Post-V1 follow-ups

- #87 fn-5xx -> rate-based
- #88 availability tests
- #89 dynamic thresholds
- #90 MSAL alert
- #91 broad auth-rejection alert
- #92 more receivers
- #93 stg/prod params
