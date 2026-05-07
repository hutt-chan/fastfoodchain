const jwt = require('jsonwebtoken');
require('dotenv').config();

function auth(requiredRoles = null) {
  return async (req, res, next) => {
    const h = req.headers.authorization;
    if (!h || !h.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Thiếu token' });
    }
    try {
      const payload = jwt.verify(h.slice(7), process.env.JWT_SECRET || 'dev');
      req.user = payload;
      if (requiredRoles && !requiredRoles.includes(payload.role)) {
        return res.status(403).json({ error: 'Không đủ quyền' });
      }
      next();
    } catch {
      return res.status(401).json({ error: 'Token không hợp lệ' });
    }
  };
}

module.exports = { auth };
