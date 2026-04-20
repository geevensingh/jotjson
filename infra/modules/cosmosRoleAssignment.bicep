@description('Name of the existing Cosmos DB account that the role assignment scopes to.')
param cosmosAccountName string

@description('Name of the database to scope the role assignment to. The built-in Data Contributor role at the database scope covers all containers beneath it.')
param databaseName string

@description('Principal id (object id) of the managed identity or service principal that should be granted read/write data access.')
param principalId string

@description('Stable seed used for the assignment resource name. Change per caller so multiple role assignments on the same account do not collide.')
param nameSeed string = principalId

resource account 'Microsoft.DocumentDB/databaseAccounts@2024-05-15' existing = {
  name: cosmosAccountName
}

// Built-in role ID for "Cosmos DB Built-in Data Contributor" — grants data-plane
// read/write on containers within the scoped database. This is different from
// the Azure RBAC Contributor role; Cosmos SQL has its own role system.
var dataContributorRoleId = '${account.id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002'
var assignmentScope = '${account.id}/dbs/${databaseName}'

resource assignment 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-05-15' = {
  parent: account
  name: guid(account.id, principalId, nameSeed, 'data-contributor')
  properties: {
    roleDefinitionId: dataContributorRoleId
    principalId: principalId
    scope: assignmentScope
  }
}
