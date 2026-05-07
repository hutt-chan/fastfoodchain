const pool = require('../db');

async function logAudit(userId, action, module, detail, ip) {
  try {
    await pool.execute(
      'INSERT INTO audit_logs (user_id, action, module, detail, ip) VALUES (?,?,?,?,?)',
      [userId || null, action, module || null, detail ? JSON.stringify(detail) : null, ip || null]
    );
  } catch {
    /* ignore audit failure */
  }
}

module.exports = { logAudit };
