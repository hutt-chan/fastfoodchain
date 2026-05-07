const crypto = require('crypto');

function generateOrderCode(prefix = 'FFC') {
  const t = Date.now().toString(36).toUpperCase();
  const r = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `${prefix}-${t}-${r}`;
}

module.exports = { generateOrderCode };
