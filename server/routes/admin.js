const express = require('express');
const pool = require('../db');
const { auth } = require('../middleware/auth');
const { logAudit } = require('../lib/audit');
const { invalidateConfigCache } = require('../services/configService');
const { OrderStatus } = require('../domain/orderStatus');
const { restockBomForOrder } = require('../services/inventoryService');
const { appendStatusHistory } = require('../services/orderService');
const { asyncHandler } = require('../middleware/asyncHandler');
const bcrypt = require('bcrypt');

const router = express.Router();
const A = auth(['ADMIN']);
const A_OR_CHAIN = auth(['ADMIN', 'CHAIN_MANAGER']);

router.get('/config', A, async (req, res) => {
  const [rows] = await pool.execute('SELECT * FROM system_config ORDER BY config_key');
  res.json({ config: rows });
});

router.patch('/config', A, async (req, res) => {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'Thiếu key' });
  await pool.execute(
    'INSERT INTO system_config (config_key, config_value) VALUES (?,?) ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)',
    [key, String(value)]
  );
  invalidateConfigCache();
  await logAudit(req.user.id, 'CONFIG_UPDATE', 'admin', { key, value }, req.ip);
  res.json({ ok: true });
});


router.get('/branches', A, async (req, res) => {
  const [rows] = await pool.execute('SELECT * FROM branches ORDER BY id');
  res.json({ branches: rows });
});

router.post('/branches', A, async (req, res) => {
  const { name, address, lat, lng, delivery_radius_km, is_active, open_time, close_time } = req.body;
  const [ins] = await pool.execute(
    `INSERT INTO branches (name, address, lat, lng, delivery_radius_km, is_active, open_time, close_time) 
     VALUES (?,?,?,?,?,?,?,?)`,
    [name, address, lat, lng, delivery_radius_km || 5, is_active !== false ? 1 : 0, open_time || '08:00:00', close_time || '22:00:00']
  );
  const bid = ins.insertId;
  const [prods] = await pool.execute('SELECT id FROM products WHERE is_active_chain = 1');
  for (const p of prods) {
    await pool.execute(
      'INSERT IGNORE INTO branch_menu (branch_id, product_id, is_available) VALUES (?,?,1)',
      [bid, p.id]
    );
  }
  const [ings] = await pool.execute('SELECT id FROM ingredients');
  for (const ing of ings) {
    await pool.execute(
      'INSERT IGNORE INTO branch_inventory (branch_id, ingredient_id, quantity) VALUES (?,?,0)',
      [bid, ing.id]
    );
  }
  await logAudit(req.user.id, 'BRANCH_CREATE', 'admin', { bid }, req.ip);
  res.json({ id: bid });
});

// router.patch('/branches/:id', A, async (req, res) => {
//   const f = req.body;
//   await pool.execute(
//     `UPDATE branches SET name = COALESCE(?, name), address = COALESCE(?, address),
//      lat = COALESCE(?, lat), lng = COALESCE(?, lng),
//      delivery_radius_km = COALESCE(?, delivery_radius_km), is_active = COALESCE(?, is_active)
//      WHERE id = ?`,
//     [f.name, f.address, f.lat, f.lng, f.delivery_radius_km, f.is_active, req.params.id]
//   );
//   await logAudit(req.user.id, 'BRANCH_UPDATE', 'admin', req.body, req.ip);
//   res.json({ ok: true });
// });

// Thêm asyncHandler để bắt lỗi tập trung
// admin.js

// --- Sửa API PATCH /branches/:id ---
router.patch('/branches/:id', A, asyncHandler(async (req, res) => {
  const { name, address, lat, lng, delivery_radius_km, is_active, open_time, close_time } = req.body;
  const branchId = req.params.id;

  // UC-11: Nếu Admin muốn TẠM ĐÓNG (is_active = 0), phải check đơn hàng pending
  if (is_active === false) {
    const [pendingOrders] = await pool.execute(
      `SELECT count(*) as count FROM orders 
       WHERE branch_id = ? AND status NOT IN ('COMPLETED', 'CANCELLED')`,
      [branchId]
    );

    if (pendingOrders[0].count > 0) {
      return res.status(400).json({ 
        error: `Chi nhánh đang có ${pendingOrders[0].count} đơn hàng chưa xử lý xong. Hãy hoàn tất hoặc hủy đơn trước khi đóng, hoặc sử dụng tính năng 'Đóng cửa khẩn cấp'.` 
      });
    }
  }

  const params = [
    name ?? null, address ?? null, lat ?? null, lng ?? null, delivery_radius_km ?? null,
    is_active !== undefined ? (is_active ? 1 : 0) : null,
    open_time ?? null, close_time ?? null, branchId
  ];

  const sql = `
    UPDATE branches 
    SET name = COALESCE(?, name), address = COALESCE(?, address),
        lat = COALESCE(?, lat), lng = COALESCE(?, lng),
        delivery_radius_km = COALESCE(?, delivery_radius_km), 
        is_active = COALESCE(?, is_active),
        open_time = COALESCE(?, open_time), close_time = COALESCE(?, close_time)
    WHERE id = ?`;

  await pool.execute(sql, params);
  await logAudit(req.user.id, 'BRANCH_UPDATE', 'admin', { branchId, updates: req.body }, req.ip);
  res.json({ ok: true });
}));

/**
 * UC-11: Đóng cửa khẩn cấp.
 * Tự huỷ toàn bộ đơn pending (chưa giao) tại chi nhánh + đặt is_active=0.
 * Hoàn trả nguyên liệu cho các đơn đã trừ kho.
 */
router.post(
  '/branches/:id/force-close',
  A,
  asyncHandler(async (req, res) => {
    const branchId = Number(req.params.id);
    const { reason } = req.body;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const cancellableStatuses = [
        OrderStatus.PENDING_PAYMENT, OrderStatus.PENDING_BRANCH,
        OrderStatus.AWAITING_KITCHEN, OrderStatus.COOKING,
        OrderStatus.READY_PACKAGING, OrderStatus.AWAITING_SHIPPER,
      ];
      const [orders] = await conn.execute(
        `SELECT id, status FROM orders WHERE branch_id = ? AND status IN (${cancellableStatuses.map(() => '?').join(',')}) FOR UPDATE`,
        [branchId, ...cancellableStatuses]
      );
      let cancelled = 0;
      for (const o of orders) {
        const [items] = await conn.execute('SELECT product_id, quantity FROM order_items WHERE order_id = ?', [o.id]);
        // Hoàn trả kho nếu đơn đã trừ (sau PENDING_PAYMENT)
        if (o.status !== OrderStatus.PENDING_PAYMENT) {
          await restockBomForOrder(conn, branchId, items);
        }
        await conn.execute(
          'UPDATE orders SET status = ?, cancel_reason = ? WHERE id = ?',
          [OrderStatus.CANCELLED, 'Force-close: ' + (reason || 'Đóng cửa khẩn cấp'), o.id]
        );
        await appendStatusHistory(conn, o.id, OrderStatus.CANCELLED, 'Force-close branch (UC-11)');
        cancelled++;
      }
      await conn.execute('UPDATE branches SET is_active = 0 WHERE id = ?', [branchId]);
      await conn.commit();
      await logAudit(req.user.id, 'BRANCH_FORCE_CLOSE', 'admin', { branchId, cancelled, reason }, req.ip);
      res.json({ ok: true, cancelled_orders: cancelled });
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  })
);

/** UC-39: Đọc cảnh báo tồn kho event-driven */
router.get('/alerts/low-stock', A_OR_CHAIN, async (req, res) => {
  const ack = req.query.ack === '1';
  const [rows] = await pool.execute(
    `SELECT a.*, i.name AS ingredient_name, i.unit, b.name AS branch_name
     FROM low_stock_alerts a
     JOIN ingredients i ON i.id = a.ingredient_id
     LEFT JOIN branches b ON b.id = a.branch_id
     WHERE a.acknowledged = ? ORDER BY a.id DESC LIMIT 200`,
    [ack ? 1 : 0]
  );
  res.json({ alerts: rows });
});

router.post('/alerts/:id/ack', A_OR_CHAIN, async (req, res) => {
  await pool.execute('UPDATE low_stock_alerts SET acknowledged = 1 WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});


// --- Sửa API PATCH /users/:id ---
router.patch('/users/:id', A, asyncHandler(async (req, res) => {
  const { is_active, reason } = req.body;
  const targetUserId = req.params.id;

  // UC-13: Nếu Admin muốn KHÓA (is_active = 0), phải check đơn hàng dở dang
  if (is_active === false) {
    const [pendingOrders] = await pool.execute(
      `SELECT count(*) as count FROM orders 
       WHERE user_id = ? AND status NOT IN ('COMPLETED', 'CANCELLED')`,
      [targetUserId]
    );

    if (pendingOrders[0].count > 0) {
      return res.status(400).json({ 
        error: `Người dùng này đang có ${pendingOrders[0].count} đơn hàng dở dang. Không thể khóa tài khoản lúc này.` 
      });
    }
  }

  await pool.execute('UPDATE users SET is_active = ? WHERE id = ?', [is_active ? 1 : 0, targetUserId]);
  await logAudit(req.user.id, 'USER_LOCK', 'admin', { target: targetUserId, is_active, reason }, req.ip);
  res.json({ ok: true });
}));

/**
 * UC-13: Xóa vĩnh viễn (Soft-delete) tài khoản
 */
router.delete('/users/:id', A, asyncHandler(async (req, res) => {
  const targetUserId = req.params.id;

  // Kiểm tra đơn hàng dở dang trước khi xóa
  const [pendingOrders] = await pool.execute(
    `SELECT count(*) as count FROM orders 
     WHERE user_id = ? AND status NOT IN ('COMPLETED', 'CANCELLED')`,
    [targetUserId]
  );

  if (pendingOrders[0].count > 0) {
    return res.status(400).json({ 
      error: `Người dùng này đang có đơn hàng dở dang. Không thể xóa tài khoản.` 
    });
  }

  // Thực hiện Xóa mềm
  await pool.execute('UPDATE users SET is_deleted = 1, is_active = 0 WHERE id = ?', [targetUserId]);
  await logAudit(req.user.id, 'USER_DELETE', 'admin', { target: targetUserId, note: 'Soft delete' }, req.ip);
  res.json({ ok: true });
}));

router.get('/users', A, async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT u.id, u.email, u.phone, u.full_name, u.is_active, u.branch_id, r.code AS role_code, u.created_at
     FROM users u JOIN roles r ON r.id = u.role_id 
     WHERE u.is_deleted = 0 
     ORDER BY u.id DESC LIMIT 500`
  );
  res.json({ users: rows });
});

router.get('/audit', A, async (req, res) => {
  const [rows] = await pool.execute(
    'SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200'
  );
  res.json({ logs: rows });
});

// Thêm vào file admin.js
router.post('/users', A, asyncHandler(async (req, res) => {
  const { full_name, phone, email, role_id, branch_id, password } = req.body;

  // 1. Kiểm tra dữ liệu bắt buộc
  if (!full_name || !phone || !role_id || !password) {
    return res.status(400).json({ error: 'Thiếu thông tin bắt buộc (Tên, SĐT, Vai trò, Mật khẩu)' });
  }

  // 2. Hash mật khẩu (Giả sử bạn dùng bcrypt hoặc thư viện tương tự)
  // const password_hash = await bcrypt.hash(password, 10);
  const password_hash = await bcrypt.hash(password, 10);

  // 3. Chèn vào DB
  // Thiết lập must_change_password = 1 để ép người dùng đổi mật khẩu khi đăng nhập lần đầu
  const [ins] = await pool.execute(
    `INSERT INTO users (email, phone, password_hash, full_name, role_id, branch_id, must_change_password, is_active) 
     VALUES (?, ?, ?, ?, ?, ?, 1, 1)`,
    [email || null, phone, password_hash, full_name, role_id, branch_id || null]
  );

  await logAudit(req.user.id, 'USER_CREATE', 'admin', { target_id: ins.insertId, phone }, req.ip);
  
  res.json({ ok: true, id: ins.insertId });
}));

/**
 * UC-13: Đặt lại mật khẩu người dùng
 * Sinh mật khẩu tạm thời và ép đổi ở lần đăng nhập sau
 */
router.post('/users/:id/reset-password', A, asyncHandler(async (req, res) => {
  const userId = req.params.id;
  
  // 1. Tạo mật khẩu tạm thời ngẫu nhiên (8 ký tự)
  const tempPassword = Math.random().toString(36).slice(-8);
  const password_hash = await bcrypt.hash(tempPassword, 10);

  // 2. Cập nhật vào DB và bật cờ must_change_password
  const [result] = await pool.execute(
    `UPDATE users 
     SET password_hash = ?, must_change_password = 1 
     WHERE id = ?`,
    [password_hash, userId]
  );

  if (result.affectedRows === 0) {
    return res.status(404).json({ error: 'Không tìm thấy người dùng' });
  }

  // 3. Ghi log audit
  await logAudit(req.user.id, 'USER_RESET_PASSWORD', 'admin', { target_id: userId }, req.ip);

  // 4. Trả về mật khẩu tạm để Admin cung cấp cho nhân viên
  res.json({ ok: true, tempPassword });
}));

// Thêm API lấy danh sách roles
router.get('/roles', A, async (req, res) => {
  // Lấy id, code và tên tiếng Việt từ bảng roles
  const [rows] = await pool.execute('SELECT id, code, name_vi FROM roles ORDER BY id');
  res.json({ roles: rows });
});

module.exports = router;
