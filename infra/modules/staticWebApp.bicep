param name string
param location string
param tags object

@allowed(['Free', 'Standard'])
param sku string = 'Free'

param customDomain string = ''

@description('App settings injected into the Functions runtime.')
param appSettings object = {}

resource swa 'Microsoft.Web/staticSites@2023-12-01' = {
  name: name
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  sku: {
    name: sku
    tier: sku
  }
  properties: {
    buildProperties: {
      appLocation: '/'
      apiLocation: 'api'
      outputLocation: 'dist/jotjson/browser'
    }
    stagingEnvironmentPolicy: 'Enabled'
    allowConfigFileUpdates: true
  }
}

resource swaSettings 'Microsoft.Web/staticSites/config@2023-12-01' = {
  parent: swa
  name: 'appsettings'
  properties: appSettings
}

resource domain 'Microsoft.Web/staticSites/customDomains@2023-12-01' = if (!empty(customDomain)) {
  parent: swa
  name: customDomain
  properties: {}
}

output defaultHostname string = swa.properties.defaultHostname
output resourceId string = swa.id
output principalId string = swa.identity.principalId
