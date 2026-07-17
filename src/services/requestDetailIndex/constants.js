const REQUEST_DETAIL_ITEM_PREFIX = 'request_detail:item:'
const REQUEST_DETAIL_DAY_INDEX_PREFIX = 'request_detail:index:day:'
const PENDING_AGE_KEY = 'request_detail:sqlite_index:pending_age'
const PENDING_VERSION_KEY = 'request_detail:sqlite_index:pending_version'
const MAINTENANCE_COMMAND_KEY = 'request_detail:sqlite_index:maintenance_command'
const MAINTENANCE_STATUS_PREFIX = 'request_detail:sqlite_index:maintenance_status:'
const MAINTENANCE_CURRENT_KEY = 'request_detail:sqlite_index:maintenance_current'
const MAINTENANCE_LAST_KEY = 'request_detail:sqlite_index:maintenance_last'
const SERVICE_HEARTBEAT_KEY = 'request_detail:sqlite_index:service_heartbeat'

const SCHEMA_VERSION = 1
const MAPPER_VERSION = 1
const SNAPSHOT_BACKEND = 'sqlite-v9'

module.exports = {
  MAINTENANCE_COMMAND_KEY,
  MAINTENANCE_CURRENT_KEY,
  MAINTENANCE_LAST_KEY,
  MAINTENANCE_STATUS_PREFIX,
  MAPPER_VERSION,
  PENDING_AGE_KEY,
  PENDING_VERSION_KEY,
  REQUEST_DETAIL_DAY_INDEX_PREFIX,
  REQUEST_DETAIL_ITEM_PREFIX,
  SERVICE_HEARTBEAT_KEY,
  SCHEMA_VERSION,
  SNAPSHOT_BACKEND
}
