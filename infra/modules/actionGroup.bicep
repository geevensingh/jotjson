@description('Resource name for the action group, e.g. ag-jotjson-dev.')
param name string

@description('Short name for the action group (1-12 characters), used in SMS/email subject prefixes.')
@maxLength(12)
param shortName string

@description('Tags applied to the resource.')
param tags object = {}

@description('Email address that receives alert notifications. Empty string disables email; the action group exists with zero receivers and alerts evaluate but send nothing.')
param notificationEmail string = ''

resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: name
  location: 'global' // action groups are always 'global'
  tags: tags
  properties: {
    groupShortName: shortName
    enabled: true
    emailReceivers: empty(notificationEmail) ? [] : [
      {
        name: 'primary'
        emailAddress: notificationEmail
        useCommonAlertSchema: true
      }
    ]
  }
}

output id string = actionGroup.id
output name string = actionGroup.name
