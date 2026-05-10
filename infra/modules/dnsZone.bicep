@description('Fully-qualified DNS zone name, e.g. jotjson.com. Empty skips creation.')
param zoneName string

param tags object = {}

resource zone 'Microsoft.Network/dnsZones@2023-07-01-preview' = {
  name: zoneName
  location: 'global'
  tags: tags
  properties: {
    zoneType: 'Public'
  }
}

@description('The four Azure-provided nameservers. Set these at the registrar (GoDaddy, etc.) to delegate the zone to Azure DNS.')
output nameServers array = zone.properties.nameServers
output zoneId string = zone.id
output zoneName string = zone.name
