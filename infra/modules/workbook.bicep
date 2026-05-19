@description('Display name shown in the App Insights workbook gallery.')
param displayName string

@description('Workbook content JSON (post-substitution) as a string.')
param serializedContent string

@description('Deterministic seed for the workbook resource name. The resource name is guid(resourceNameSeed) so callers using the same seed update the same resource in place.')
param resourceNameSeed string

@description('Azure region for the workbook resource.')
param location string

@description('Resource ID of the App Insights component the workbook queries.')
param componentId string

@description('Logical purpose of the workbook. Drives the purpose tag for filterable inventory.')
@allowed([
  'operator-monitoring'
  'product-analytics'
  'telemetry-hygiene'
  'sw-migration'
])
param purpose string

@description('Workbook kind. shared = visible to all RG users; user = personal workbook scoped to creator.')
@allowed([
  'shared'
  'user'
])
param kind string = 'shared'

@description('Workbook gallery category. Defaults to the generic workbook gallery.')
param category string = 'workbook'

@description('Base tags merged onto the resource. The purpose tag is appended automatically.')
param tags object = {}

resource workbook 'Microsoft.Insights/workbooks@2022-04-01' = {
  name: guid(resourceNameSeed)
  location: location
  kind: kind
  tags: union(tags, { purpose: purpose })
  properties: {
    category: category
    displayName: displayName
    serializedData: serializedContent
    sourceId: componentId
    version: 'Notebook/1.0'
  }
}

output id string = workbook.id
output displayName string = workbook.properties.displayName
