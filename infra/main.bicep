targetScope = 'resourceGroup'

@description('Environment short name: dev, stg, prod, nonprod.')
@allowed(['dev', 'stg', 'prod', 'nonprod'])
param environmentName string = 'dev'

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('Short app name used as prefix for resource names.')
@minLength(3)
@maxLength(10)
param appName string = 'jotjson'

@description('Custom domain for the Static Web App. Leave empty to skip domain binding.')
param customDomain string = ''

@description('Azure DNS zone name to create in this resource group, e.g. jotjson.com. Empty skips zone creation. Delegate at the registrar by pointing nameservers at the zone outputs.')
param dnsZoneName string = ''

@description('SKU tier for the Static Web App.')
@allowed(['Free', 'Standard'])
param staticWebAppSku string = 'Free'

@description('Microsoft Entra External ID tenant id (GUID). Empty disables JWT validation in the API.')
param entraTenantId string = ''

@description('Entra External ID authority URL, e.g. https://<subdomain>.ciamlogin.com/<tenantId>/. Empty disables JWT validation in the API.')
param entraAuthority string = ''

@description('Client id (application id) of the SPA app registration.')
param entraSpaClientId string = ''

@description('Client id (application id) of the API app registration. The API validates that incoming access tokens have this id as their audience.')
param entraApiClientId string = ''

@description('Expected audience claim for API access tokens. Typically api://<entraApiClientId>. Empty disables JWT validation in the API.')
param entraApiAudience string = ''

@description('Email address to receive M7i operational alerts (boot.failed, app.unhandled, fn-5xx, auth-config). Empty disables email receivers; alerts still fire and surface in the Azure portal Alerts blade. See issue #94 for follow-up.')
param notificationEmail string = ''

var resourceSuffix = toLower('${appName}-${environmentName}')
var tags = {
  app: appName
  env: environmentName
  managedBy: 'bicep'
}

module cosmos 'modules/cosmosDb.bicep' = {
  name: 'cosmos'
  params: {
    accountName: 'cosmos-${resourceSuffix}'
    location: location
    tags: tags
  }
}

module storage 'modules/blobStorage.bicep' = {
  name: 'storage'
  params: {
    accountName: 'st${replace(resourceSuffix, '-', '')}'
    location: location
    tags: tags
  }
}

module insights 'modules/appInsights.bicep' = {
  name: 'insights'
  params: {
    name: 'appi-${resourceSuffix}'
    location: location
    tags: tags
  }
}

module monitoringActions 'modules/actionGroup.bicep' = {
  name: 'monitoringActions'
  params: {
    name: 'ag-${resourceSuffix}'
    shortName: 'jotjson'
    tags: tags
    notificationEmail: notificationEmail
  }
}

// Resource-name seed convention:
// - operatorWorkbook uses `resourceSuffix` UNSUFFIXED so guid() resolves
//   to the same name as the pre-refactor `monitoringWorkbook` resource.
//   This makes the deploy an in-place property update (displayName +
//   serializedData + tags), preserving saved-portal links and edit
//   history.
// - productAnalyticsWorkbook uses `'${resourceSuffix}-analytics'`,
//   producing a distinct guid -> new resource.
// - Any future caller MUST use a distinct seed unless it intentionally
//   targets one of the existing GUIDs.
var operatorWorkbookContentTemplate = loadTextContent('workbooks/monitoring.json')
var operatorWorkbookContent = replace(
  replace(operatorWorkbookContentTemplate, '__ENVIRONMENT_NAME__', environmentName),
  '__COMPONENT_ID__',
  insights.outputs.componentId
)

module operatorWorkbook 'modules/workbook.bicep' = {
  name: 'operatorWorkbook'
  params: {
    displayName: 'JotJSON operator monitoring'
    serializedContent: operatorWorkbookContent
    resourceNameSeed: resourceSuffix
    location: location
    componentId: insights.outputs.componentId
    purpose: 'operator-monitoring'
    tags: tags
  }
}

var productAnalyticsContentTemplate = loadTextContent('workbooks/product-analytics.json')
var productAnalyticsContent = replace(
  replace(productAnalyticsContentTemplate, '__ENVIRONMENT_NAME__', environmentName),
  '__COMPONENT_ID__',
  insights.outputs.componentId
)

module productAnalyticsWorkbook 'modules/workbook.bicep' = {
  name: 'productAnalyticsWorkbook'
  params: {
    displayName: 'JotJSON product analytics'
    serializedContent: productAnalyticsContent
    resourceNameSeed: '${resourceSuffix}-analytics'
    location: location
    componentId: insights.outputs.componentId
    purpose: 'product-analytics'
    tags: tags
  }
}

var swMigrationContentTemplate = loadTextContent('workbooks/sw-migration.json')
var swMigrationContent = replace(
  replace(swMigrationContentTemplate, '__ENVIRONMENT_NAME__', environmentName),
  '__COMPONENT_ID__',
  insights.outputs.componentId
)

module swMigrationWorkbook 'modules/workbook.bicep' = {
  name: 'swMigrationWorkbook'
  params: {
    displayName: 'JotJSON SW migration verification'
    serializedContent: swMigrationContent
    resourceNameSeed: '${resourceSuffix}-sw-migration'
    location: location
    componentId: insights.outputs.componentId
    purpose: 'sw-migration'
    tags: tags
  }
}

module monitoringAlerts 'modules/alerts.bicep' = {
  name: 'monitoringAlerts'
  params: {
    namePrefix: resourceSuffix
    location: location
    workspaceId: insights.outputs.workspaceId
    actionGroupId: monitoringActions.outputs.id
    tags: tags
  }
}

module swa 'modules/staticWebApp.bicep' = {
  name: 'swa'
  params: {
    name: 'swa-${resourceSuffix}'
    location: location
    tags: tags
    sku: staticWebAppSku
    customDomain: customDomain
    appSettings: {
      COSMOS_ENDPOINT: cosmos.outputs.endpoint
      COSMOS_DATABASE: cosmos.outputs.databaseName
      COSMOS_KEY: cosmos.outputs.primaryKey
      BLOB_STORAGE_ACCOUNT: storage.outputs.accountName
      AVATAR_CONTAINER: storage.outputs.avatarsContainer
      EXPORT_CONTAINER: storage.outputs.exportsContainer
      APPLICATIONINSIGHTS_CONNECTION_STRING: insights.outputs.connectionString
      ENTRA_TENANT_ID: entraTenantId
      ENTRA_SPA_CLIENT_ID: entraSpaClientId
      ENTRA_API_CLIENT_ID: entraApiClientId
      ENTRA_AUTHORITY: entraAuthority
      ENTRA_API_AUDIENCE: entraApiAudience
    }
  }
}

module dns 'modules/dnsZone.bicep' = if (!empty(dnsZoneName)) {
  name: 'dns'
  params: {
    zoneName: dnsZoneName
    tags: tags
  }
}

module swaCosmosRole 'modules/cosmosRoleAssignment.bicep' = {
  name: 'swaCosmosRole'
  params: {
    cosmosAccountName: cosmos.outputs.accountName
    databaseName: cosmos.outputs.databaseName
    principalId: swa.outputs.principalId
    nameSeed: 'swa'
  }
}

output staticWebAppHostname string = swa.outputs.defaultHostname
output staticWebAppPrincipalId string = swa.outputs.principalId
output dnsNameServers array = empty(dnsZoneName) ? [] : dns.outputs.nameServers
output cosmosEndpoint string = cosmos.outputs.endpoint
output storageAccountName string = storage.outputs.accountName
output appInsightsConnectionString string = insights.outputs.connectionString
output operatorWorkbookId string = operatorWorkbook.outputs.id
output productAnalyticsWorkbookId string = productAnalyticsWorkbook.outputs.id
output swMigrationWorkbookId string = swMigrationWorkbook.outputs.id
