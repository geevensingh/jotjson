param accountName string
param location string
param tags object
param databaseName string = 'jotjson'

@description('Backup policy type. "Periodic" preserves Azure default; "Continuous" enables Continuous7Days PITR. Continuous->Periodic is one-way; choose carefully.')
@allowed(['Periodic', 'Continuous'])
param backupPolicyType string = 'Periodic'

resource account 'Microsoft.DocumentDB/databaseAccounts@2024-05-15' = {
  name: accountName
  location: location
  tags: tags
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    locations: [
      {
        locationName: location
        failoverPriority: 0
      }
    ]
    capabilities: [
      { name: 'EnableServerless' }
    ]
    consistencyPolicy: {
      defaultConsistencyLevel: 'Session'
    }
    enableAutomaticFailover: false
    enableMultipleWriteLocations: false
    backupPolicy: backupPolicyType == 'Continuous' ? {
      type: 'Continuous'
      continuousModeProperties: {
        tier: 'Continuous7Days'
      }
    } : {
      type: 'Periodic'
      periodicModeProperties: {
        backupIntervalInMinutes: 240
        backupRetentionIntervalInHours: 8
        backupStorageRedundancy: 'Geo'
      }
    }
  }
}

resource db 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-05-15' = {
  parent: account
  name: databaseName
  properties: {
    resource: {
      id: databaseName
    }
  }
}

var containers = [
  { name: 'blobs', partitionKey: '/ownerId', ttl: -1 }
  { name: 'users', partitionKey: '/id', ttl: -1 }
  { name: 'history', partitionKey: '/userId', ttl: -1 }
  { name: 'rule-sets', partitionKey: '/userId', ttl: -1 }
]

resource containerResources 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = [for c in containers: {
  parent: db
  name: c.name
  properties: {
    resource: {
      id: c.name
      partitionKey: {
        paths: [c.partitionKey]
        kind: 'Hash'
      }
      defaultTtl: c.ttl
      indexingPolicy: {
        indexingMode: 'consistent'
        includedPaths: [{ path: '/*' }]
        excludedPaths: [{ path: '/"_etag"/?' }]
      }
    }
  }
}]

output endpoint string = account.properties.documentEndpoint
output accountName string = account.name
output accountId string = account.id
output databaseName string = db.name

@secure()
output primaryKey string = account.listKeys().primaryMasterKey
