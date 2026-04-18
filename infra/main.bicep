targetScope = 'resourceGroup'

@description('Environment short name: dev, stg, prod.')
@allowed(['dev', 'stg', 'prod'])
param environmentName string = 'dev'

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('Short app name used as prefix for resource names.')
@minLength(3)
@maxLength(10)
param appName string = 'jotjson'

@description('Custom domain for the Static Web App. Leave empty to skip domain binding.')
param customDomain string = ''

@description('SKU tier for the Static Web App.')
@allowed(['Free', 'Standard'])
param staticWebAppSku string = 'Free'

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
      BLOB_STORAGE_ACCOUNT: storage.outputs.accountName
      AVATAR_CONTAINER: storage.outputs.avatarsContainer
      EXPORT_CONTAINER: storage.outputs.exportsContainer
      APPLICATIONINSIGHTS_CONNECTION_STRING: insights.outputs.connectionString
    }
  }
}

output staticWebAppHostname string = swa.outputs.defaultHostname
output cosmosEndpoint string = cosmos.outputs.endpoint
output storageAccountName string = storage.outputs.accountName
output appInsightsConnectionString string = insights.outputs.connectionString
