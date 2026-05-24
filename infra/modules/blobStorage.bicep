param accountName string
param location string
param tags object

@description('Storage account SKU. Default Standard_LRS matches historical behavior; Standard_GZRS recommended for production.')
@allowed(['Standard_LRS', 'Standard_GRS', 'Standard_ZRS', 'Standard_GZRS', 'Standard_RAGRS', 'Standard_RAGZRS'])
param sku string = 'Standard_LRS'

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: accountName
  location: location
  tags: tags
  sku: {
    name: sku
  }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
    accessTier: 'Hot'
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    cors: {
      corsRules: []
    }
    deleteRetentionPolicy: {
      enabled: true
      days: 7
    }
  }
}

resource avatars 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'avatars'
  properties: {
    publicAccess: 'None'
  }
}

resource exports 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'exports'
  properties: {
    publicAccess: 'None'
  }
}

resource sourcemaps 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'sourcemaps'
  properties: {
    publicAccess: 'None'
  }
}

output accountName string = storage.name
output avatarsContainer string = avatars.name
output exportsContainer string = exports.name
output sourcemapsContainer string = sourcemaps.name
