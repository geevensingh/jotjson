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
                                       (auto, via APPLICATIONINSIGHTS_CONNECTION_STRING)

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
| `customEvents` | `TelemetryService.trackEvent` (currently called by ... not many call sites; future feature events go here) |
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

### Proxy URL recipe

Two cluster URLs map to the same data; pick whichever schema you prefer.

App Insights (classic schema):

```
https://ade.applicationinsights.io/subscriptions/<subId>/resourcegroups/<rg>/providers/microsoft.insights/components/appi-<resourceSuffix>
```

Log Analytics workspace (App-prefixed schema):

```
https://ade.loganalytics.io/subscriptions/<subId>/resourcegroups/<rg>/providers/microsoft.operationalinsights/workspaces/appi-<resourceSuffix>-law
```

Find the actual values for any other environment:

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

Substituted into the recipe above, the proxy URLs to paste into ADX Web UI
or Kusto Explorer are:

App Insights (classic schema, `traces` / `exceptions` / `customEvents` / ...):

```
https://ade.applicationinsights.io/subscriptions/db5e75e4-b980-486d-a11e-fe9327a52031/resourcegroups/rg-jotjson-dev/providers/microsoft.insights/components/appi-jotjson-dev
```

Log Analytics workspace (App-prefixed schema, `AppTraces` / `AppExceptions` /
`AppEvents` / ...):

```
https://ade.loganalytics.io/subscriptions/db5e75e4-b980-486d-a11e-fe9327a52031/resourcegroups/rg-jotjson-dev/providers/microsoft.operationalinsights/workspaces/appi-jotjson-dev-law
```

When `stg` and `prod` are stood up they follow the same naming -- just swap
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

---

## Starter KQL query catalog

Tested against the classic AI schema. For LAW, swap the table name (see
the mapping above) and rename `timestamp` to `TimeGenerated`.

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
