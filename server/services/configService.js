const pool = require('../db');

const cache = new Map();
const TTL_MS = 60_000;

async function getConfigValue(key, defaultValue = null) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) {
    return hit.value;
  }
  const [[row]] = await pool.execute('SELECT config_value FROM system_config WHERE config_key = ?', [key]);
  const value = row ? row.config_value : defaultValue;
  cache.set(key, { value, at: now });
  return value;
}

async function getNumberConfig(key, defaultValue) {
  const raw = await getConfigValue(key, null);
  if (raw == null || raw === '') return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) ? n : defaultValue;
}

function invalidateConfigCache() {
  cache.clear();
}

module.exports = { getConfigValue, getNumberConfig, invalidateConfigCache };
