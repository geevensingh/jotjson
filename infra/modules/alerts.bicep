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
