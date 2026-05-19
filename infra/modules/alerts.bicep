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

// SW migration verification alert. Fires hourly if any session
// emits `sw.activated` with `buildNumber < cutoverBuildNumber`,
// i.e. is still running the pre-migration build. The placeholder
// `999999999` is the LOUD fail-safe direction: until backfilled
// post-merge per docs/sw-migration.md, every session matches and
// the alert fires on every evaluation. A backfilled value gives
// a quiet alarm during normal operation and a loud alarm if a
// stuck cohort plateaus above threshold.
resource swMigrationStuckCohortAlert 'Microsoft.Insights/scheduledQueryRules@2026-03-01' = {
  name: 'alert-${namePrefix}-sw-migration-stuck-cohort'
  location: location
  tags: tags
  kind: 'LogAlert'
  properties: {
    description: 'JotJSON sessions still running pre-migration SW build. See docs/sw-migration.md for the cutover-backfill procedure and observation schedule.'
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
let cutoverBuildNumber = 999999999;
AppEvents
| where TimeGenerated > ago(1h)
| where Name == 'sw.activated'
| extend buildNumber = toint(Properties.buildNumber)
| where isnotnull(buildNumber)
| where buildNumber < cutoverBuildNumber
| summarize hourly = dcount(SessionId) '''
          timeAggregation: 'Count'
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
