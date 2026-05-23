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

@description('Existing App Insights resource name to reuse instead of creating a new one. When set, must be paired with existingAppInsightsRg. Used during region migration to share telemetry across environments. Leave empty (default) to create a new AI resource.')
param existingAppInsightsName string = ''

@description('Resource group of the existing App Insights resource (see existingAppInsightsName). Must be set when existingAppInsightsName is set; otherwise leave empty.')
param existingAppInsightsRg string = ''

@description('Existing Azure DNS zone resource group. When set, this template assumes the zone already exists in that RG and skips zone creation. Leave empty to deploy the zone inline (current behavior).')
param existingDnsZoneRg string = ''

@description('When true (default), deploys workbooks, alerts, and action group. Set to false during region migrations to avoid double-deploying monitoring against shared App Insights. The permanent switch supports any future "infra without monitoring" scenario.')
param deployMonitoring bool = true

@description('Cosmos DB backup policy type, passed through to cosmosDb module. See module for details.')
@allowed(['Periodic', 'Continuous'])
param cosmosBackupPolicyType string = 'Periodic'

@description('Storage account SKU, passed through to blobStorage module. See module for details.')
@allowed(['Standard_LRS', 'Standard_GRS', 'Standard_ZRS', 'Standard_GZRS', 'Standard_RAGRS', 'Standard_RAGZRS'])
param storageSku string = 'Standard_LRS'

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
    backupPolicyType: cosmosBackupPolicyType
  }
}

module storage 'modules/blobStorage.bicep' = {
  name: 'storage'
  params: {
    accountName: 'st${replace(resourceSuffix, '-', '')}'
    location: location
    tags: tags
    sku: storageSku
  }
}

module insights 'modules/appInsights.bicep' = if (!useExternalAi) {
  name: 'insights'
  params: {
    name: 'appi-${resourceSuffix}'
    location: location
    tags: tags
  }
}

resource existingAi 'Microsoft.Insights/components@2020-02-02' existing = if (!empty(existingAppInsightsName) && !empty(existingAppInsightsRg)) {
  name: existingAppInsightsName
  scope: resourceGroup(existingAppInsightsRg)
}

var useExternalAi = !empty(existingAppInsightsName) && !empty(existingAppInsightsRg)
var aiConnectionString = useExternalAi ? existingAi!.properties.ConnectionString : insights!.outputs.connectionString
var aiResourceId = useExternalAi ? existingAi!.id : insights!.outputs.componentId
var aiWorkspaceId = useExternalAi ? existingAi!.properties.WorkspaceResourceId : insights!.outputs.workspaceId

// deployMonitoring=false suppresses workbooks/alerts/action group. Used during
// region migrations to avoid double-deploying monitoring against shared App
// Insights. Defaults to true; the permanent switch supports any future
// "infra without monitoring" scenario.
module monitoringActions 'modules/actionGroup.bicep' = if (deployMonitoring) {
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
  aiResourceId
)

module operatorWorkbook 'modules/workbook.bicep' = if (deployMonitoring) {
  name: 'operatorWorkbook'
  params: {
    displayName: 'JotJSON operator monitoring'
    serializedContent: operatorWorkbookContent
    resourceNameSeed: resourceSuffix
    location: location
    componentId: aiResourceId
    purpose: 'operator-monitoring'
    tags: tags
  }
}

var productAnalyticsContentTemplate = loadTextContent('workbooks/product-analytics.json')
var productAnalyticsContent = replace(
  replace(productAnalyticsContentTemplate, '__ENVIRONMENT_NAME__', environmentName),
  '__COMPONENT_ID__',
  aiResourceId
)

module productAnalyticsWorkbook 'modules/workbook.bicep' = if (deployMonitoring) {
  name: 'productAnalyticsWorkbook'
  params: {
    displayName: 'JotJSON product analytics'
    serializedContent: productAnalyticsContent
    resourceNameSeed: '${resourceSuffix}-analytics'
    location: location
    componentId: aiResourceId
    purpose: 'product-analytics'
    tags: tags
  }
}

var swMigrationContentTemplate = loadTextContent('workbooks/sw-migration.json')
var swMigrationContent = replace(
  replace(swMigrationContentTemplate, '__ENVIRONMENT_NAME__', environmentName),
  '__COMPONENT_ID__',
  aiResourceId
)

module swMigrationWorkbook 'modules/workbook.bicep' = if (deployMonitoring) {
  name: 'swMigrationWorkbook'
  params: {
    displayName: 'JotJSON SW migration verification'
    serializedContent: swMigrationContent
    resourceNameSeed: '${resourceSuffix}-sw-migration'
    location: location
    componentId: aiResourceId
    purpose: 'sw-migration'
    tags: tags
  }
}

module monitoringAlerts 'modules/alerts.bicep' = if (deployMonitoring) {
  name: 'monitoringAlerts'
  params: {
    namePrefix: resourceSuffix
    location: location
    workspaceId: aiWorkspaceId
    actionGroupId: monitoringActions!.outputs.id
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
      APPLICATIONINSIGHTS_CONNECTION_STRING: aiConnectionString
      ENTRA_TENANT_ID: entraTenantId
      ENTRA_SPA_CLIENT_ID: entraSpaClientId
      ENTRA_API_CLIENT_ID: entraApiClientId
      ENTRA_AUTHORITY: entraAuthority
      ENTRA_API_AUDIENCE: entraApiAudience
    }
  }
}

module dns 'modules/dnsZone.bicep' = if (!empty(dnsZoneName) && empty(existingDnsZoneRg)) {
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
output dnsNameServers array = (empty(dnsZoneName) || !empty(existingDnsZoneRg)) ? [] : dns!.outputs.nameServers
output cosmosEndpoint string = cosmos.outputs.endpoint
output storageAccountName string = storage.outputs.accountName
output appInsightsConnectionString string = aiConnectionString
output operatorWorkbookId string = deployMonitoring ? operatorWorkbook!.outputs.id : ''
output productAnalyticsWorkbookId string = deployMonitoring ? productAnalyticsWorkbook!.outputs.id : ''
output swMigrationWorkbookId string = deployMonitoring ? swMigrationWorkbook!.outputs.id : ''
