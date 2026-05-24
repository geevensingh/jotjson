param accountName string
param location string
param tags object
param databaseName string = 'jotjson'

@description('Backup policy type. "Periodic" (default) leaves backup config unmanaged so existing Azure account-level settings are preserved on redeploy -- this is the no-op default for dev / nonprod where backupPolicy was historically unset. "Continuous" enables Continuous7Days PITR explicitly, which is required for Phase 1 of the region migration (see docs/migration-westus2.md). Continuous->Periodic is one-way; choose carefully. Note: PITR restores do not carry over backupPolicy (docs/migration-westus2.md Phase 2 step 4), so the restored account must be redeployed via this template under Continuous to re-state the policy.')
@allowed(['Periodic', 'Continuous'])
param backupPolicyType string = 'Periodic'

// Emit backupPolicy ONLY on the Continuous branch via union(); on Periodic
// (the default) we intentionally omit the property so ARM preserves the
// existing account-level state. This keeps the no-op promise for the
// committed dev.bicepparam and nonprod.bicepparam, neither of which sets
// cosmosBackupPolicyType. See docs/migration-westus2.md "PR-A" section.
var backupPolicyProperty = backupPolicyType == 'Continuous'
  ? {
      backupPolicy: {
        type: 'Continuous'
        continuousModeProperties: {
          tier: 'Continuous7Days'
        }
      }
    }
  : {}

resource account 'Microsoft.DocumentDB/databaseAccounts@2024-05-15' = {
  name: accountName
  location: location
  tags: tags
  kind: 'GlobalDocumentDB'
  properties: union(
    {
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
    },
    backupPolicyProperty
  )
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
