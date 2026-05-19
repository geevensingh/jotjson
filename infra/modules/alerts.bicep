@description('Resource name prefix used for each alert, e.g. jotjson-dev (becomes alert-\${prefix}-boot-failed, etc.).')
param namePrefix string

@description('Azure region for the alerts.')
param location string

@description('Resource ID of the Log Analytics workspace to query.')
param workspaceId string

@description('Resource ID of the action group to notify when an alert fires.')
param actionGroupId string

@description('Tags applied to all alerts.')
param tags object = {}

resource bootFailedAlert 'Microsoft.Insights/scheduledQueryRules@2026-03-01' = {
  name: 'alert-${namePrefix}-boot-failed'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    description: 'JotJSON SPA failed to bootstrap. Boot-failure record was replayed from sessionStorage on next load.'
    severity: 1
    enabled: true
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    scopes: [
      workspaceId
    ]
    criteria: {
      allOf: [
        {
          query: '''
AppExceptions
| where TimeGenerated > ago(15m)
| where tostring(Properties.messageId) == 'boot.failed' '''
          timeAggregation: 'Count'
          threshold: 0
          operator: 'GreaterThan'
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [
        actionGroupId
      ]
    }
    autoMitigate: true
  }
}

resource appUnhandledAlert 'Microsoft.Insights/scheduledQueryRules@2026-03-01' = {
  name: 'alert-${namePrefix}-app-unhandled'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    description: 'JotJSON SPA unhandled exception spike.'
    severity: 2
    enabled: true
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    scopes: [
      workspaceId
    ]
    criteria: {
      allOf: [
        {
          query: '''
AppExceptions
| where TimeGenerated > ago(15m)
| where tostring(Properties.messageId) == 'app.unhandled' '''
          timeAggregation: 'Count'
          threshold: 5
          operator: 'GreaterThan'
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [
        actionGroupId
      ]
    }
    autoMitigate: true
  }
}

resource functions5xxAlert 'Microsoft.Insights/scheduledQueryRules@2026-03-01' = {
  name: 'alert-${namePrefix}-fn-5xx'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    description: 'JotJSON Functions backend returned 2 or more 5xx responses in the last 15 minutes.'
    severity: 2
    enabled: true
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    scopes: [
      workspaceId
    ]
    criteria: {
      allOf: [
        {
          query: '''
AppRequests
| where TimeGenerated > ago(15m)
| where ResultCode startswith '5' '''
          timeAggregation: 'Count'
          threshold: 2
          operator: 'GreaterThanOrEqual'
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [
        actionGroupId
      ]
    }
    autoMitigate: true
  }
}

resource authConfigAlert 'Microsoft.Insights/scheduledQueryRules@2026-03-01' = {
  name: 'alert-${namePrefix}-auth-config'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    description: 'JotJSON API rejected a token with wrong audience or wrong issuer. This indicates a deploy-time auth configuration drift, never user behavior.'
    severity: 2
    enabled: true
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    scopes: [
      workspaceId
    ]
    criteria: {
      allOf: [
        {
          query: '''
AppEvents
| where TimeGenerated > ago(15m)
| where Name == 'auth.tokenRejected'
| where tostring(Properties.reason) in ('wrong_audience', 'wrong_issuer') '''
          timeAggregation: 'Count'
          threshold: 0
          operator: 'GreaterThan'
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [
        actionGroupId
      ]
    }
    autoMitigate: true
  }
}

// SW migration verification alert. Fires hourly when more than
// 10 distinct sessions in the last hour emit `sw.activated` with
// `buildNumber < 646` (the SW migration cutover, established by
// PR #330 squash-merge commit `2b1704c`, backfilled 2026-05-19).
//
// Threshold semantics: the criteria below sets
// `metricMeasureColumn: 'StuckSessions'` so the threshold is
// compared against the value of the StuckSessions column (a
// `dcount(SessionId)`), not the row count of the query results.
//
// Why per-session dedup instead of raw events: a single stuck
// client that reloads on every keystroke could emit hundreds of
// `sw.activated` events per hour. Thresholding against raw event
// count (the simpler "drop `summarize` and let Count count rows"
// alternative) would inflate the apparent cohort size and fire on
// one chatty client. `dcount(SessionId)` measures the metric we
// actually care about: how many DISTINCT users are still on the
// pre-cutover SW build.
//
// An earlier shape (no `metricMeasureColumn` + `timeAggregation:
// 'Count'` on a `summarize`-reduced single-row result) was
// structurally unable to fire because Count counted result rows
// (always 1) and `1 > 10` is false. See
// `docs/telemetry.md` (Alert query gotcha section) for the
// row-vs-aggregate pattern reference.
//
// To update for a future SW migration, see docs/sw-migration.md.
resource swMigrationStuckCohortAlert 'Microsoft.Insights/scheduledQueryRules@2026-03-01' = {
  name: 'alert-${namePrefix}-sw-migration-stuck-cohort'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    description: 'JotJSON sessions still running pre-migration SW build. See docs/sw-migration.md for the cutover history and observation schedule.'
    severity: 2
    enabled: true
    evaluationFrequency: 'PT1H'
    windowSize: 'PT1H'
    scopes: [
      workspaceId
    ]
    criteria: {
      allOf: [
        {
          query: '''
let cutoverBuildNumber = 646;
AppEvents
| where TimeGenerated > ago(1h)
| where Name == 'sw.activated'
| extend buildNumber = toint(Properties.buildNumber)
| where isnotnull(buildNumber)
| where buildNumber < cutoverBuildNumber
| summarize StuckSessions = dcount(SessionId) '''
          metricMeasureColumn: 'StuckSessions'
          timeAggregation: 'Total'
          threshold: 10
          operator: 'GreaterThan'
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [
        actionGroupId
      ]
    }
    autoMitigate: true
  }
}
