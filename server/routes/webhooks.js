const express = require('express');
const crypto = require('crypto');
const pool = require('../db');
const {
  canFulfillOrder,
  consumeBomForOrder,
  refreshBranchProductAvailability,
  checkAndEmitLowStockAlerts,
} = require('../services/inventoryService');
const {
  lockOrderById,
  transitionOrderLocked,
  setPaymentStatus,
  appendStatusHistory,
} = require('../services/orderService');
const { OrderStatus, PaymentStatus } = require('../domain/orderStatus');
const { asyncHandler } = require('../middleware/asyncHandler');

const router = express.Router();

function getSecret() {
  return process.env.WEBHOOK_HMAC_SECRET || 'dev-hmac-secret-change-me';
}

function verifySig(rawBody, sigHeader) {
  if (!sigHeader || typeof sigHeader !== 'string') return false;
  const h = crypto.createHmac('sha256', getSecret()).update(rawBody).digest('hex');
  if (h.length !== sigHeader.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(sigHeader));
  } catch {
    return false;
  }
}

/** UC-45 — Cổng thanh toán callback (server-to-server) */
router.post(
  '/payment',
  express.raw({ type: 'application/json' }),
  asyncHandler(async (req, res) => {
  const raw = req.body.toString();
  const sig = req.headers['x-signature'];
  if (!verifySig(raw, sig)) {
    return res.status(401).json({ error: 'Chữ ký không hợp lệ' });
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return res.status(400).json({ error: 'JSON không hợp lệ' });
  }
  const { order_id, result, amount, transaction_ref } = body;
  const [[o0]] = await pool.execute('SELECT * FROM orders WHERE id = ?', [order_id]);
  if (!o0) return res.status(404).json({ error: 'Đơn không tồn tại' });

  if (result === 'success' && o0.status === OrderStatus.PENDING_PAYMENT) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const o = await lockOrderById(conn, order_id);
      if (!o || o.status !== OrderStatus.PENDING_PAYMENT) {
        await conn.rollback();
        return res.status(409).json({ error: 'Đơn không còn chờ thanh toán' });
      }
      const [items] = await conn.execute(
        'SELECT product_id, quantity, unit_price, product_name FROM order_items WHERE order_id = ?',
        [order_id]
      );
      const lines = items.map((i) => ({
        product_id: i.product_id,
        quantity: i.quantity,
        unit_price: i.unit_price,
        name: i.product_name,
      }));
      const check = await canFulfillOrder(o.branch_id, lines);
      if (!check.ok) {
        await conn.rollback();
        return res.status(409).json({ error: 'Tồn kho không đủ sau thanh toán', detail: check });
      }
      await consumeBomForOrder(conn, o.branch_id, lines);
      await transitionOrderLocked(conn, o, OrderStatus.PENDING_BRANCH, 'Webhook thanh toán thành công');
      await setPaymentStatus(conn, order_id, PaymentStatus.PAID);
      await conn.execute(
        'INSERT INTO payment_transactions (order_id, gateway_ref, status, amount, raw_payload) VALUES (?,?,?,?,?)',
        [order_id, transaction_ref || 'WH', 'SUCCESS', amount || o.total, raw]
      );
      if (o.voucher_id) {
        await conn.execute('UPDATE vouchers SET used_count = used_count + 1 WHERE id = ?', [o.voucher_id]);
      }
      await conn.execute('DELETE FROM cart_items WHERE user_id = ? AND branch_id = ?', [o.user_id, o.branch_id]);
      await conn.commit();
      await refreshBranchProductAvailability(
        o.branch_id,
        lines.map((l) => l.product_id)
      );
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  } else if (result === 'failed') {
    await pool.execute(
      'INSERT INTO payment_transactions (order_id, gateway_ref, status, amount, raw_payload) VALUES (?,?,?,?,?)',
      [order_id, transaction_ref || 'WH', 'FAILED', amount || 0, raw]
    );
  }
  res.json({ received: true });
  })
);

/** UC-42 / UC-43 — Đơn vị vận chuyển */
router.post(
  '/shipment',
  express.raw({ type: 'application/json' }),
  asyncHandler(async (req, res) => {
  const raw = req.body.toString();
  const sig = req.headers['x-signature'];
  if (!verifySig(raw, sig)) {
    return res.status(401).json({ error: 'Chữ ký không hợp lệ' });
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return res.status(400).json({ error: 'JSON không hợp lệ' });
  }
  const { order_id, status, lat, lng, cod_collected, fail_reason } = body;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const o = await lockOrderById(conn, order_id);
    if (!o) {
      await conn.rollback();
      return res.status(404).json({ error: 'Không tìm thấy' });
    }
    await conn.execute(
      `INSERT INTO delivery_tracking (order_id, external_shipment_id, status, last_lat, last_lng)
       VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE status = VALUES(status), last_lat = VALUES(last_lat), last_lng = VALUES(last_lng)`,
      [order_id, body.shipment_id || 'EXT', status || 'UPDATE', lat || null, lng || null]
    );
    if (status === 'DELIVERED' && o.status === OrderStatus.DELIVERING) {
      await transitionOrderLocked(conn, o, OrderStatus.COMPLETED, 'Giao hàng thành công');
      if (o.payment_method === 'COD') {
        // UC-43: COD_FAILED nếu không thu được, COD_COLLECTED nếu thu thành công
        await setPaymentStatus(conn, order_id, cod_collected ? PaymentStatus.COD_COLLECTED : PaymentStatus.COD_FAILED);
      }
    } else if ((status === 'FAILED' || status === 'COD_FAILED' || status === 'RETURNED') && o.status === OrderStatus.DELIVERING) {
      // UC-43 mở rộng: ĐVVC trả về vì khách boom hàng / không nhận
      await transitionOrderLocked(conn, o, OrderStatus.FAILED_DELIVERY, fail_reason || 'Giao thất bại');
      if (o.payment_method === 'COD') {
        await setPaymentStatus(conn, order_id, PaymentStatus.COD_FAILED);
      }
      // Tự động ghi nhận hao hụt (food waste)
      const [items] = await conn.execute(
        `SELECT product_id, quantity, unit_price FROM order_items WHERE order_id = ?`,
        [order_id]
      );
      let totalCost = 0;
      for (const it of items) totalCost += Number(it.unit_price) * Number(it.quantity);
      const [insW] = await conn.execute(
        `INSERT INTO food_waste (branch_id, order_id, reason, total_cost, created_by) VALUES (?,?,?,?,?)`,
        [o.branch_id, order_id, 'DELIVERY_FAILED', totalCost, null]
      );
      const wid = insW.insertId;
      for (const it of items) {
        await conn.execute(
          `INSERT INTO food_waste_lines (waste_id, product_id, quantity, unit_cost) VALUES (?,?,?,?)`,
          [wid, it.product_id, it.quantity, it.unit_price]
        );
      }
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  res.json({ received: true });
  })
);

module.exports = router;
