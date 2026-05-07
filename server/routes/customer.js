const express = require('express');
const pool = require('../db');
const { auth } = require('../middleware/auth');
const { distanceKm } = require('../utils/geo');
const {
  canFulfillOrder,
  consumeBomForOrder,
  refreshBranchProductAvailability,
  restockBomForOrder,
  checkAndEmitLowStockAlerts,
} = require('../services/inventoryService');
const { getNumberConfig } = require('../services/configService');
const {
  appendStatusHistory,
  transitionOrderLocked,
  lockOrderById,
  setPaymentStatus,
} = require('../services/orderService');
const { OrderStatus, PaymentStatus, canTransition } = require('../domain/orderStatus');
const { generateOrderCode } = require('../utils/orderCode');
const { logAudit } = require('../lib/audit');

const router = express.Router();

router.get('/branches', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const [rows] = await pool.execute('SELECT * FROM branches WHERE is_active = 1');
  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return res.json({ branches: rows, nearest: rows[0] || null });
  }
  const globalMaxKm = await getNumberConfig('max_delivery_radius_km', 10);
  let best = null;
  let bestD = Infinity;
  for (const b of rows) {
    const d = distanceKm(lat, lng, Number(b.lat), Number(b.lng));
    const serveKm = Math.min(Number(b.delivery_radius_km), globalMaxKm);
    if (d <= serveKm && d < bestD) {
      bestD = d;
      best = { ...b, distance_km: Math.round(d * 100) / 100 };
    }
  }
  if (!best) {
    return res.json({
      branches: rows,
      nearest: null,
      message: 'Khu vuc cua ban chua co co so phuc vu trong ban kinh',
    });
  }
  res.json({ branches: rows, nearest: best });
});

router.get('/branches/:id/menu', async (req, res) => {
  const branchId = req.params.id;
  // UC-31 auto-resume: tự bật lại các món đã hết "thời gian dự kiến phục hồi"
  const { refreshBranchProductAvailability } = require('../services/inventoryService');
  await refreshBranchProductAvailability(branchId).catch(() => {});
  // UC-15 soft-delete: chỉ trả về món chưa bị xóa mềm
  const [items] = await pool.execute(
    `SELECT p.id, p.name, p.description, p.image_url, p.base_price, p.prep_time_minutes, c.name AS category_name,
            bm.price_override, bm.is_available, bm.manual_off, bm.auto_off, bm.manual_off_until
     FROM branch_menu bm
     JOIN products p ON p.id = bm.product_id
     JOIN categories c ON c.id = p.category_id
     WHERE bm.branch_id = ? AND p.is_active_chain = 1 AND p.is_deleted = 0
     ORDER BY c.sort_order, p.name`,
    [branchId]
  );
  res.json({ items });
});

router.get('/cart', auth(['CUSTOMER']), async (req, res) => {
  const branchId = req.query.branch_id;
  if (!branchId) return res.status(400).json({ error: 'Thieu branch_id' });
  const [items] = await pool.execute(
    `SELECT ci.*, p.name, COALESCE(bm.price_override, p.base_price) AS unit_price, bm.is_available
     FROM cart_items ci
     JOIN products p ON p.id = ci.product_id
     JOIN branch_menu bm ON bm.product_id = p.id AND bm.branch_id = ci.branch_id
     WHERE ci.user_id = ? AND ci.branch_id = ?`,
    [req.user.id, branchId]
  );
  res.json({ items });
});

router.post('/cart/items', auth(['CUSTOMER']), async (req, res) => {
  const { branch_id, product_id, quantity, note } = req.body;
  if (!branch_id || !product_id) return res.status(400).json({ error: 'Thieu du lieu' });
  const [[bm]] = await pool.execute(
    'SELECT is_available, manual_off FROM branch_menu WHERE branch_id = ? AND product_id = ?',
    [branch_id, product_id]
  );
  if (!bm || !bm.is_available) {
    return res.status(400).json({ error: 'Mon khong kha dung tai chi nhanh nay' });
  }
  await pool.execute(
    `INSERT INTO cart_items (user_id, branch_id, product_id, quantity, note)
     VALUES (?,?,?,?,?)
     ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity), note = VALUES(note)`,
    [req.user.id, branch_id, product_id, quantity || 1, note || null]
  );
  res.json({ ok: true });
});

router.patch('/cart/items/:id', auth(['CUSTOMER']), async (req, res) => {
  const { quantity } = req.body;
  await pool.execute('UPDATE cart_items SET quantity = ? WHERE id = ? AND user_id = ?', [
    quantity,
    req.params.id,
    req.user.id,
  ]);
  res.json({ ok: true });
});

router.delete('/cart/items/:id', auth(['CUSTOMER']), async (req, res) => {
  await pool.execute('DELETE FROM cart_items WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  res.json({ ok: true });
});

router.post('/vouchers/validate', auth(['CUSTOMER']), async (req, res) => {
  const { code, branch_id, subtotal } = req.body;
  const today = new Date().toISOString().slice(0, 10);
  const [[v]] = await pool.execute(
    `SELECT * FROM vouchers WHERE code = ? AND is_active = 1 AND valid_from <= ? AND valid_to >= ?
     AND (branch_id IS NULL OR branch_id = ?)`,
    [code, today, today, branch_id]
  );
  if (!v) return res.status(400).json({ error: 'Ma khong hop le hoac het han' });
  if (v.used_count >= v.max_uses) return res.status(400).json({ error: 'Ma da het luot' });
  if (Number(subtotal) < Number(v.min_order_amount)) {
    return res.status(400).json({
      error: 'Don can toi thieu ' + v.min_order_amount + ' de ap dung',
    });
  }
  let discount = 0;
  if (v.discount_type === 'PERCENT') {
    discount = (Number(subtotal) * Number(v.discount_value)) / 100;
  } else {
    discount = Number(v.discount_value);
  }
  res.json({ voucher_id: v.id, discount_amount: Math.round(discount), voucher: v });
});

router.post('/orders', auth(['CUSTOMER']), async (req, res) => {
  const {
    branch_id,
    payment_method,
    delivery_address,
    delivery_lat,
    delivery_lng,
    voucher_id,
  } = req.body;
  if (!branch_id || !delivery_address) {
    return res.status(400).json({ error: 'Thieu chi nhanh hoac dia chi giao' });
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [cart] = await conn.execute(
      `SELECT ci.*, COALESCE(bm.price_override, p.base_price) AS unit_price, p.name
       FROM cart_items ci
       JOIN products p ON p.id = ci.product_id
       JOIN branch_menu bm ON bm.product_id = p.id AND bm.branch_id = ci.branch_id
       WHERE ci.user_id = ? AND ci.branch_id = ?`,
      [req.user.id, branch_id]
    );
    if (!cart.length) {
      await conn.rollback();
      return res.status(400).json({ error: 'Gio hang trong' });
    }
    let subtotal = 0;
    const lines = cart.map((c) => {
      subtotal += Number(c.unit_price) * c.quantity;
      return { product_id: c.product_id, quantity: c.quantity, unit_price: c.unit_price, name: c.name };
    });
    let discount = 0;
    // UC-04: Khóa hàng voucher (FOR UPDATE) + double-check số lần dùng & hiệu lực ngay trước khi chốt đơn
    if (voucher_id) {
      const today = new Date().toISOString().slice(0, 10);
      const [[v]] = await conn.execute('SELECT * FROM vouchers WHERE id = ? FOR UPDATE', [voucher_id]);
      if (!v || !v.is_active) {
        await conn.rollback();
        return res.status(400).json({ error: 'Voucher khong ton tai hoac da bi tat' });
      }
      if (v.valid_from > today || v.valid_to < today) {
        await conn.rollback();
        return res.status(400).json({ error: 'Voucher khong trong thoi gian hieu luc' });
      }
      if (Number(v.used_count) >= Number(v.max_uses)) {
        await conn.rollback();
        return res.status(400).json({ error: 'Voucher da het luot dung' });
      }
      if (v.branch_id != null && Number(v.branch_id) !== Number(branch_id)) {
        await conn.rollback();
        return res.status(400).json({ error: 'Voucher khong ap dung cho chi nhanh nay' });
      }
      if (subtotal >= Number(v.min_order_amount)) {
        if (v.discount_type === 'PERCENT') discount = (subtotal * Number(v.discount_value)) / 100;
        else discount = Number(v.discount_value);
      } else {
        await conn.rollback();
        return res.status(400).json({ error: 'Don chua dat toi thieu de ap dung voucher' });
      }
    }
    const ship = await getNumberConfig('base_shipping_fee', 20000);
    const total = Math.max(0, subtotal - discount + ship);

    const check = await canFulfillOrder(branch_id, lines);
    if (!check.ok) {
      await conn.rollback();
      return res.status(400).json({ error: 'Ton kho chi nhanh khong du cho don nay', detail: check });
    }

    const orderCode = generateOrderCode();
    const payMethod = payment_method === 'ONLINE' ? 'ONLINE' : 'COD';
    let status = OrderStatus.PENDING_BRANCH;
    let payStatus = payMethod === 'COD' ? PaymentStatus.COD_PENDING : PaymentStatus.PENDING;
    let paymentDeadlineSql = null;

    if (payMethod === 'ONLINE') {
      status = OrderStatus.PENDING_PAYMENT;
      // UC-05: timeout chờ thanh toán (mặc định 5 phút, lấy từ config)
      const timeoutMin = await getNumberConfig('order_payment_timeout_minutes', 5);
      paymentDeadlineSql = timeoutMin;
    }

    const [ins] = await conn.execute(
      `INSERT INTO orders (order_code, user_id, branch_id, status, payment_method, payment_status,
       subtotal, discount_amount, shipping_fee, total, voucher_id, delivery_address, delivery_lat, delivery_lng,
       payment_deadline)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,
       ${paymentDeadlineSql ? 'DATE_ADD(NOW(), INTERVAL ? MINUTE)' : 'NULL'})`,
      paymentDeadlineSql
        ? [orderCode, req.user.id, branch_id, status, payMethod, payStatus, subtotal, discount, ship, total,
            voucher_id || null, delivery_address, delivery_lat || null, delivery_lng || null, paymentDeadlineSql]
        : [orderCode, req.user.id, branch_id, status, payMethod, payStatus, subtotal, discount, ship, total,
            voucher_id || null, delivery_address, delivery_lat || null, delivery_lng || null]
    );
    const orderId = ins.insertId;
    for (const line of lines) {
      await conn.execute(
        `INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price) VALUES (?,?,?,?,?)`,
        [orderId, line.product_id, line.name, line.quantity, line.unit_price]
      );
    }
    await conn.execute('INSERT INTO order_status_history (order_id, status, note) VALUES (?,?,?)', [
      orderId,
      status,
      'Tao don',
    ]);

    if (payMethod === 'COD') {
      await consumeBomForOrder(conn, branch_id, lines);
      await conn.execute('DELETE FROM cart_items WHERE user_id = ? AND branch_id = ?', [
        req.user.id,
        branch_id,
      ]);
      if (voucher_id) {
        await conn.execute('UPDATE vouchers SET used_count = used_count + 1 WHERE id = ?', [voucher_id]);
      }
    }

    await conn.commit();

    if (payMethod === 'COD') {
      const pids = lines.map((l) => l.product_id);
      await refreshBranchProductAvailability(branch_id, pids);
      // UC-39: cảnh báo tồn kho sự kiện ngay khi trừ kho
      const { aggregateBomNeed } = require('../services/inventoryService');
      const need = await aggregateBomNeed(pool, lines);
      await checkAndEmitLowStockAlerts('BRANCH', branch_id, [...need.keys()]);
    }

    await logAudit(req.user.id, 'PLACE_ORDER', 'orders', { orderId, orderCode }, req.ip);
    res.json({
      order_id: orderId,
      order_code: orderCode,
      status,
      payment_status: payStatus,
      total,
      pay_method: payMethod,
    });
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
});

router.post('/orders/:id/after-online-pay', auth(['CUSTOMER']), async (req, res) => {
  const orderId = req.params.id;
  const [[o]] = await pool.execute(
    'SELECT * FROM orders WHERE id = ? AND user_id = ?',
    [orderId, req.user.id]
  );
  if (!o || o.payment_method !== 'ONLINE' || o.status !== OrderStatus.PENDING_PAYMENT) {
    return res.status(400).json({ error: 'Don khong hop le' });
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const locked = await lockOrderById(conn, orderId);
    if (!locked || locked.status !== OrderStatus.PENDING_PAYMENT) {
      await conn.rollback();
      return res.status(400).json({ error: 'Don khong con cho thanh toan' });
    }
    const [items] = await conn.execute(
      'SELECT product_id, quantity, unit_price, product_name FROM order_items WHERE order_id = ?',
      [orderId]
    );
    const lines = items.map((i) => ({
      product_id: i.product_id,
      quantity: i.quantity,
      unit_price: i.unit_price,
      name: i.product_name,
    }));
    const check = await canFulfillOrder(locked.branch_id, lines);
    if (!check.ok) {
      await conn.rollback();
      return res.status(400).json({ error: 'Ton kho khong du', detail: check });
    }
    await consumeBomForOrder(conn, locked.branch_id, lines);
    await transitionOrderLocked(conn, locked, OrderStatus.PENDING_BRANCH, 'Thanh toan online thanh cong');
    await setPaymentStatus(conn, orderId, PaymentStatus.PAID);
    await conn.execute(
      'INSERT INTO payment_transactions (order_id, gateway_ref, status, amount) VALUES (?,?,?,?)',
      [orderId, 'MOCK-' + Date.now(), 'SUCCESS', locked.total]
    );
    if (locked.voucher_id) {
      await conn.execute('UPDATE vouchers SET used_count = used_count + 1 WHERE id = ?', [locked.voucher_id]);
    }
    await conn.execute('DELETE FROM cart_items WHERE user_id = ? AND branch_id = ?', [
      req.user.id,
      locked.branch_id,
    ]);
    await conn.commit();
    await refreshBranchProductAvailability(
      locked.branch_id,
      lines.map((l) => l.product_id)
    );
    // UC-39: emit low-stock alerts after online payment consumes BOM
    const { aggregateBomNeed } = require('../services/inventoryService');
    const need = await aggregateBomNeed(pool, lines);
    await checkAndEmitLowStockAlerts('BRANCH', locked.branch_id, [...need.keys()]);
    res.json({ ok: true });
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
});

/**
 * UC-05: Auto-cancel các đơn ONLINE đã quá payment_deadline.
 * Gọi định kỳ trong các endpoint đọc đơn để giải phóng tồn kho ảo.
 */
async function autoCancelExpiredPayments() {
  const [expired] = await pool.execute(
    `SELECT id FROM orders WHERE status = ? AND payment_method = 'ONLINE'
     AND payment_deadline IS NOT NULL AND payment_deadline < NOW()`,
    [OrderStatus.PENDING_PAYMENT]
  );
  for (const o of expired) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[locked]] = await conn.execute('SELECT * FROM orders WHERE id = ? FOR UPDATE', [o.id]);
      if (locked && locked.status === OrderStatus.PENDING_PAYMENT && locked.payment_deadline && new Date(locked.payment_deadline) < new Date()) {
        await conn.execute(
          'UPDATE orders SET status = ?, cancel_reason = ? WHERE id = ?',
          [OrderStatus.CANCELLED, 'Hết hạn thanh toán (UC-05)', o.id]
        );
        await appendStatusHistory(conn, o.id, OrderStatus.CANCELLED, 'Auto cancel: hết hạn thanh toán');
      }
      await conn.commit();
    } catch { await conn.rollback(); } finally { conn.release(); }
  }
}

router.get('/orders', auth(['CUSTOMER']), async (req, res) => {
  await autoCancelExpiredPayments();
  const [rows] = await pool.execute(
    `SELECT o.*, b.name AS branch_name FROM orders o
     JOIN branches b ON b.id = o.branch_id WHERE o.user_id = ? ORDER BY o.created_at DESC`,
    [req.user.id]
  );
  res.json({ orders: rows });
});

router.get('/orders/:id', auth(['CUSTOMER']), async (req, res) => {
  const [[o]] = await pool.execute(
    `SELECT o.*, b.name AS branch_name FROM orders o JOIN branches b ON b.id = o.branch_id
     WHERE o.id = ? AND o.user_id = ?`,
    [req.params.id, req.user.id]
  );
  if (!o) return res.status(404).json({ error: 'Khong tim thay' });
  const [items] = await pool.execute('SELECT * FROM order_items WHERE order_id = ?', [o.id]);
  const [[dt]] = await pool.execute('SELECT * FROM delivery_tracking WHERE order_id = ?', [o.id]);
  const [history] = await pool.execute(
    'SELECT * FROM order_status_history WHERE order_id = ? ORDER BY id',
    [o.id]
  );
  res.json({ order: o, items, delivery: dt || null, history });
});

router.post('/orders/:id/cancel', auth(['CUSTOMER']), async (req, res) => {
  const { reason } = req.body;
  const [[o]] = await pool.execute('SELECT * FROM orders WHERE id = ? AND user_id = ?', [
    req.params.id,
    req.user.id,
  ]);
  if (!o) return res.status(404).json({ error: 'Khong tim thay' });
  if (!canTransition(o.status, OrderStatus.CANCELLED)) {
    return res.status(400).json({ error: 'Khong the huy don o trang thai nay' });
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const locked = await lockOrderById(conn, o.id);
    if (!canTransition(locked.status, OrderStatus.CANCELLED)) {
      await conn.rollback();
      return res.status(400).json({ error: 'Don da doi trang thai, khong huy duoc' });
    }
    await conn.execute(
      `UPDATE orders SET status = ?, cancel_reason = ? WHERE id = ?`,
      [OrderStatus.CANCELLED, reason || 'Khach huy', o.id]
    );
    await appendStatusHistory(conn, o.id, OrderStatus.CANCELLED, reason || '');
    if (locked.status !== OrderStatus.PENDING_PAYMENT) {
      const [items] = await conn.execute(
        'SELECT product_id, quantity FROM order_items WHERE order_id = ?',
        [o.id]
      );
      await restockBomForOrder(conn, locked.branch_id, items);
    }
    await conn.commit();
    await refreshBranchProductAvailability(o.branch_id);
    await logAudit(req.user.id, 'CANCEL_ORDER', 'orders', { orderId: o.id }, req.ip);
    res.json({ ok: true });
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
});

router.post('/orders/:id/review', auth(['CUSTOMER']), async (req, res) => {
  const { rating_food, rating_delivery, comment } = req.body;
  const [[o]] = await pool.execute('SELECT * FROM orders WHERE id = ? AND user_id = ?', [
    req.params.id,
    req.user.id,
  ]);
  if (!o || o.status !== OrderStatus.COMPLETED) {
    return res.status(400).json({ error: 'Chi danh gia don da hoan thanh' });
  }
  try {
    await pool.execute(
      `INSERT INTO reviews (order_id, user_id, rating_food, rating_delivery, comment) VALUES (?,?,?,?,?)`,
      [o.id, req.user.id, rating_food || 5, rating_delivery || 5, comment || null]
    );
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Don da duoc danh gia' });
    }
    throw e;
  }
});

module.exports = router;
