const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { auth } = require('../middleware/auth');
const { logAudit } = require('../lib/audit');
require('dotenv').config();

const router = express.Router();

function signToken(row) {
  return jwt.sign(
    {
      id: row.id,
      role: row.role_code,
      branch_id: row.branch_id,
      full_name: row.full_name,
    },
    process.env.JWT_SECRET || 'dev',
    { expiresIn: '7d' }
  );
}

router.post('/register', async (req, res) => {
  const { email, phone, password, full_name, default_address, default_lat, default_lng } = req.body;
  if (!phone || !password || !full_name) {
    return res.status(400).json({ error: 'Thiếu SĐT, mật khẩu hoặc họ tên' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Mật khẩu tối thiểu 8 ký tự' });
  }
  try {
    const [[r]] = await pool.execute('SELECT id FROM roles WHERE code = ?', ['CUSTOMER']);
    const hash = await bcrypt.hash(password, 10);
    const [ins] = await pool.execute(
      `INSERT INTO users (email, phone, password_hash, full_name, role_id, default_address, default_lat, default_lng)
       VALUES (?,?,?,?,?,?,?,?)`,
      [email || null, phone, hash, full_name, r.id, default_address || null, default_lat || null, default_lng || null]
    );
    const [[user]] = await pool.execute(
      `SELECT u.id, u.email, u.phone, u.full_name, u.branch_id, u.default_address, r.code AS role_code
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
      [ins.insertId]
    );
    await logAudit(user.id, 'REGISTER', 'auth', { phone }, req.ip);
    res.json({ token: signToken(user), user });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'SĐT hoặc email đã tồn tại' });
    }
    throw e;
  }
});

router.post('/login', async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.status(400).json({ error: 'Thiếu thông tin' });
  const [[user]] = await pool.execute(
    `SELECT u.*, r.code AS role_code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.phone = ?`,
    [phone]
  );
  if (!user || !user.is_active) {
    return res.status(401).json({ error: 'Sai thông tin hoặc tài khoản bị khóa' });
  }
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Sai thông tin đăng nhập' });
  delete user.password_hash;
  await logAudit(user.id, 'LOGIN', 'auth', null, req.ip);
  res.json({ token: signToken(user), user });
});

router.get('/me', auth(), async (req, res) => {
  const [[user]] = await pool.execute(
    `SELECT u.id, u.email, u.phone, u.full_name, u.branch_id, u.default_address, u.default_lat, u.default_lng, u.is_active, r.code AS role_code
     FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
    [req.user.id]
  );
  res.json(user);
});

router.patch('/profile', auth(['CUSTOMER']), async (req, res) => {
  const { full_name, email, default_address, default_lat, default_lng } = req.body;
  await pool.execute(
    `UPDATE users SET full_name = COALESCE(?, full_name), email = COALESCE(?, email),
     default_address = COALESCE(?, default_address), default_lat = COALESCE(?, default_lat), default_lng = COALESCE(?, default_lng)
     WHERE id = ?`,
    [full_name, email, default_address, default_lat, default_lng, req.user.id]
  );
  await logAudit(req.user.id, 'UPDATE_PROFILE', 'auth', req.body, req.ip);
  res.json({ ok: true });
});

router.patch('/password', auth(), async (req, res) => {
  const { old_password, new_password } = req.body;
  if (!new_password || new_password.length < 8) {
    return res.status(400).json({ error: 'Mật khẩu mới không hợp lệ' });
  }
  const [[u]] = await pool.execute('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  if (old_password) {
    const ok = await bcrypt.compare(old_password, u.password_hash);
    if (!ok) return res.status(400).json({ error: 'Mật khẩu cũ sai' });
  }
  const hash = await bcrypt.hash(new_password, 10);
  await pool.execute('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', [
    hash,
    req.user.id,
  ]);
  await logAudit(req.user.id, 'CHANGE_PASSWORD', 'auth', null, req.ip);
  res.json({ ok: true });
});

module.exports = router;
