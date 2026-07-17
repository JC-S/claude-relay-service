const coordinator = require('./coordinator')
const { loadRequestDetailIndexConfig } = require('./config')
const constants = require('./constants')
const mapper = require('./mapper')

module.exports = coordinator
module.exports.loadRequestDetailIndexConfig = loadRequestDetailIndexConfig
module.exports.constants = constants
module.exports.mapper = mapper
