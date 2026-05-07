const express = require('express');
const pool = require('../db');
const { auth } = require('../middleware/auth');
const { logAudit } = require('../lib/audit');
const crypto = require('crypto');
const { refreshBranchProductAvailability } = require('../services/inventoryService');
const { transitionOrder } = require('../services/orderService');
const { OrderStatus } = require('../domain/orderStatus');
const { asyncHandler } = require('../middleware/asyncHandler');

const router = express.Router();
const B = auth(['BRANCH_MANAGER', 'ADMIN']);

/** Phạm vi chi nhánh: Admin có thể truyền ?branch_id= hoặc thao tác toàn chuỗi (không gán). */
function branchScope(req) {
  if (req.user.role === 'ADMIN') {
    return req.query.branch_id != null && req.query.branch_id !== ''
      ? Number(req.query.branch_id)
      : null;
  }
  return req.user.branch_id;
}

function obCode() {
  return 'XK-' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex');
}

router.get('/dashboard', B, async (req, res) => {
  const bid = req.user.role === 'ADMIN' ? Number(req.query.branch_id) || 1 : req.user.branch_id;
  if (!bid) return res.status(400).json({ error: 'Không gán chi nhánh' });
  const [counts] = await pool.execute(
    `SELECT status, COUNT(*) AS c FROM orders WHERE branch_id = ? AND DATE(created_at) = CURDATE() GROUP BY status`,
    [bid]
  );
  const [[pending]] = await pool.execute(
    `SELECT COUNT(*) AS c FROM orders WHERE branch_id = ? AND status = 'PENDING_BRANCH'`,
    [bid]
  );
  res.json({ branch_id: bid, status_counts: counts, pending_confirm: pending.c });
});

router.get('/orders', B, async (req, res) => {
  const bid = req.user.role === 'ADMIN' ? Number(req.query.branch_id) || 1 : req.user.branch_id;
  const [rows] = await pool.execute(
    `SELECT o.*, u.full_name AS customer_name FROM orders o
     JOIN users u ON u.id = o.user_id WHERE o.branch_id = ? ORDER BY o.created_at DESC LIMIT 100`,
    [bid]
  );
  res.json({ orders: rows });
});

router.post(
  '/orders/:id/confirm',
  B,
  asyncHandler(async (req, res) => {
    const scope = branchScope(req);
    await transitionOrder(req.params.id, OrderStatus.AWAITING_KITCHEN, {
      note: 'Chi nhánh xác nhận',
      branchId: scope,
      role: req.user.role,
    });
    await logAudit(req.user.id, 'ORDER_CONFIRM', 'branch', { orderId: req.params.id }, req.ip);
    res.json({ ok: true });
  })
);

router.get('/menu', B, async (req, res) => {
  const bid = req.user.role === 'ADMIN' ? Number(req.query.branch_id) || 1 : req.user.branch_id;
  const [rows] = await pool.execute(
    `SELECT bm.*, p.name FROM branch_menu bm JOIN products p ON p.id = bm.product_id WHERE bm.branch_id = ?`,
    [bid]
  );
  res.json({ items: rows });
});

router.patch('/menu/:productId', B, async (req, res) => {
  const bid = req.user.role === 'ADMIN' ? Number(req.query.branch_id) || 1 : req.user.branch_id;
  // UC-31: hỗ trợ manual_off_until_minutes (số phút) để tự bật lại
  const { manual_off, manual_off_reason, manual_off_until_minutes } = req.body;
  const pid = parseInt(req.params.productId, 10);
  if (manual_off) {
    const minutes = Number(manual_off_until_minutes) > 0 ? Number(manual_off_until_minutes) : null;
    if (minutes) {
      await pool.execute(
        `UPDATE branch_menu SET manual_off = 1, manual_off_reason = ?, is_available = 0,
         manual_off_until = DATE_ADD(NOW(), INTERVAL ? MINUTE)
         WHERE branch_id = ? AND product_id = ?`,
        [manual_off_reason || null, minutes, bid, pid]
      );
    } else {
      await pool.execute(
        `UPDATE branch_menu SET manual_off = 1, manual_off_reason = ?, is_available = 0, manual_off_until = NULL
         WHERE branch_id = ? AND product_id = ?`,
        [manual_off_reason || null, bid, pid]
      );
    }
  } else {
    await pool.execute(
      `UPDATE branch_menu SET manual_off = 0, manual_off_reason = NULL, manual_off_until = NULL
       WHERE branch_id = ? AND product_id = ?`,
      [bid, pid]
    );
    await refreshBranchProductAvailability(bid, [pid]);
  }
  await logAudit(req.user.id, 'MENU_TOGGLE', 'branch', req.body, req.ip);
  res.json({ ok: true });
});

router.get('/inventory', B, async (req, res) => {
  const bid = req.user.branch_id;
  const [rows] = await pool.execute(
    `SELECT bi.*, i.name, i.unit FROM branch_inventory bi
     JOIN ingredients i ON i.id = bi.ingredient_id WHERE bi.branch_id = ?`,
    [bid]
  );
  res.json({ inventory: rows });
});

router.get('/ingredients', B, async (req, res) => {
  const [rows] = await pool.execute('SELECT id, name, unit FROM ingredients ORDER BY name');
  res.json({ ingredients: rows });
});

router.get('/stock-requests', B, async (req, res) => {
  const bid = req.user.role === 'ADMIN' ? Number(req.query.branch_id) || 1 : req.user.branch_id;
  const [rows] = await pool.execute(
    `SELECT sr.*, COUNT(srl.id) AS line_count FROM stock_requests sr
     LEFT JOIN stock_request_lines srl ON srl.stock_request_id = sr.id
     WHERE sr.branch_id = ? GROUP BY sr.id ORDER BY sr.id DESC LIMIT 50`,
    [bid]
  );
  res.json({ requests: rows });
});

// --- THÊM ĐOẠN API MỚI NÀY VÀO ---
router.get('/stock-requests/:id', B, async (req, res) => {
  const bid = req.user.role === 'ADMIN' ? null : req.user.branch_id;
  
  // Lấy thông tin chung của phiếu
  const [[request]] = await pool.execute(
    `SELECT * FROM stock_requests WHERE id = ? ${bid ? 'AND branch_id = ?' : ''}`,
    bid ? [req.params.id, bid] : [req.params.id]
  );
  if (!request) return res.status(404).json({ error: 'Không tìm thấy phiếu xin hàng' });

  // Lấy chi tiết các dòng nguyên liệu trong phiếu
  const [lines] = await pool.execute(
    `SELECT srl.*, i.name AS ingredient_name, i.unit 
     FROM stock_request_lines srl
     JOIN ingredients i ON i.id = srl.ingredient_id 
     WHERE srl.stock_request_id = ?`,
    [req.params.id]
  );
  res.json({ request, lines });
});
// ---------------------------------

router.get('/orders/:id', B, async (req, res) => {
  const bid = req.user.role === 'ADMIN' ? null : req.user.branch_id;
  const [[o]] = await pool.execute(
    `SELECT o.*, u.full_name AS customer_name, u.phone AS customer_phone, b.name AS branch_name
     FROM orders o JOIN users u ON u.id = o.user_id JOIN branches b ON b.id = o.branch_id
     WHERE o.id = ? ${bid ? 'AND o.branch_id = ?' : ''}`,
    bid ? [req.params.id, bid] : [req.params.id]
  );
  if (!o) return res.status(404).json({ error: 'Không tìm thấy' });
  const [items] = await pool.execute('SELECT * FROM order_items WHERE order_id = ?', [o.id]);
  const [history] = await pool.execute(
    'SELECT * FROM order_status_history WHERE order_id = ? ORDER BY id',
    [o.id]
  );
  res.json({ order: o, items, history });
});

router.post('/stock-requests', B, async (req, res) => {
  const bid = req.user.branch_id;
  const { lines, is_urgent } = req.body;
  if (!lines?.length) return res.status(400).json({ error: 'Thiếu dòng hàng' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [ins] = await conn.execute(
      'INSERT INTO stock_requests (branch_id, status, is_urgent) VALUES (?,?,?)',
      [bid, 'NEW', is_urgent ? 1 : 0]
    );
    const rid = ins.insertId;
    for (const l of lines) {
      await conn.execute(
        'INSERT INTO stock_request_lines (stock_request_id, ingredient_id, qty_requested) VALUES (?,?,?)',
        [rid, l.ingredient_id, l.qty_requested]
      );
    }

    let status = 'NEEDS_MANUAL';
    if (!is_urgent) {
      const [reqLines] = await conn.execute(
        'SELECT ingredient_id, qty_requested FROM stock_request_lines WHERE stock_request_id = ?',
        [rid]
      );
      let ok = true;
      for (const rl of reqLines) {
        const [[ci]] = await conn.execute(
          'SELECT quantity FROM central_inventory WHERE ingredient_id = ?',
          [rl.ingredient_id]
        );
        if (!ci || Number(ci.quantity) < Number(rl.qty_requested)) {
          ok = false;
          break;
        }
      }
      if (ok) {
        status = 'APPROVED_AUTO';
        await conn.execute(`UPDATE stock_requests SET status = ? WHERE id = ?`, [status, rid]);
        for (const rl of reqLines) {
          await conn.execute(
            'UPDATE stock_request_lines SET qty_approved = ? WHERE stock_request_id = ? AND ingredient_id = ?',
            [rl.qty_requested, rid, rl.ingredient_id]
          );
        }
        const [insO] = await conn.execute(
          'INSERT INTO stock_outbounds (stock_request_id, code, status) VALUES (?,?,?)',
          [rid, obCode(), 'PENDING_PICK']
        );
        const oid = insO.insertId;
        for (const rl of reqLines) {
          await conn.execute(
            'INSERT INTO stock_outbound_lines (stock_outbound_id, ingredient_id, quantity) VALUES (?,?,?)',
            [oid, rl.ingredient_id, rl.qty_requested]
          );
        }
      } else {
        await conn.execute(`UPDATE stock_requests SET status = 'NEEDS_MANUAL' WHERE id = ?`, [rid]);
      }
    } else {
      await conn.execute(`UPDATE stock_requests SET status = 'NEEDS_MANUAL' WHERE id = ?`, [rid]);
    }

    await conn.commit();
    await logAudit(req.user.id, 'STOCK_REQUEST', 'branch', { rid, status }, req.ip);
    res.json({ id: rid, status });
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
});

// router.get('/reports', B, async (req, res) => {
//   const bid = req.user.branch_id;
//   const from = req.query.from || '1970-01-01';
//   const to = req.query.to || '2099-12-31';
//   const [[s]] = await pool.execute(
//     `SELECT COALESCE(SUM(total),0) AS revenue, COUNT(*) AS orders FROM orders
//      WHERE branch_id = ? AND status = 'COMPLETED' AND DATE(created_at) BETWEEN ? AND ?`,
//     [bid, from, to]
//   );
//   res.json({ summary: s });
// });

router.get('/reports', B, async (req, res) => {
  const bid = req.user.branch_id;
  const from = req.query.from || '1970-01-01';
  const to = req.query.to || '2099-12-31';
  const type = req.query.type || 'day'; // Loại báo cáo mặc định là theo ngày

  // Lấy tổng quan (Summary) như cũ
  const [[s]] = await pool.execute(
    `SELECT COALESCE(SUM(total),0) AS revenue, COUNT(*) AS orders FROM orders
     WHERE branch_id = ? AND status = 'COMPLETED' AND DATE(created_at) BETWEEN ? AND ?`,
    [bid, from, to]
  );

  // Xây dựng câu SQL để nhóm chi tiết (Details)
  let dateFormatSQL = '';
  if (type === 'day') {
    dateFormatSQL = 'DATE_FORMAT(created_at, "%Y-%m-%d")'; // Nhóm theo ngày
  } else if (type === 'month') {
    dateFormatSQL = 'DATE_FORMAT(created_at, "%Y-%m")';    // Nhóm theo tháng
  } else if (type === 'year') {
    dateFormatSQL = 'DATE_FORMAT(created_at, "%Y")';       // Nhóm theo năm
  }

  // Lấy danh sách chi tiết
  const [details] = await pool.execute(
    `SELECT 
        ${dateFormatSQL} AS label, 
        COALESCE(SUM(total),0) AS revenue, 
        COUNT(*) AS orders 
     FROM orders
     WHERE branch_id = ? AND status = 'COMPLETED' AND DATE(created_at) BETWEEN ? AND ?
     GROUP BY label
     ORDER BY label DESC`,
    [bid, from, to]
  );

  // Trả về cả tổng quan và chi tiết
  res.json({ summary: s, details: details });
});

/** Goi van chuyen (UC-36 mock) — chuyen don sang DELIVERING */
/**
 * UC-36: Gọi ĐVVC với ETA tính động dựa trên tiến độ nấu thực tế.
 * - Nếu đã đóng gói (packaged_at): pickup ngay (lead_time tối thiểu).
 * - Nếu chưa: ước tính = max(prep_time còn lại) + lead_time + queue tại bếp (số COOKING khác).
 */
router.post(
  '/orders/:id/dispatch-delivery',
  B,
  asyncHandler(async (req, res) => {
    const { getNumberConfig } = require('../services/configService');
    const scope = branchScope(req);
    const [[before]] = await pool.execute('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!before) return res.status(404).json({ error: 'Khong tim thay' });

    // ETA động (UC-36)
    const leadMin = await getNumberConfig('dispatch_lead_time_min', 5);
    let etaMin = leadMin;
    if (!before.packaged_at) {
      const [items] = await pool.execute(
        `SELECT oi.product_id, oi.cook_status, p.prep_time_minutes
         FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?`,
        [before.id]
      );
      let maxRemaining = 0;
      for (const it of items) {
        if (it.cook_status === 'READY') continue;
        const elapsed = before.kitchen_started_at ? Math.max(0, (Date.now() - new Date(before.kitchen_started_at).getTime()) / 60000) : 0;
        const remain = Math.max(0, Number(it.prep_time_minutes) - elapsed);
        if (remain > maxRemaining) maxRemaining = remain;
      }
      const [[busy]] = await pool.execute(
        `SELECT COUNT(*) AS c FROM orders WHERE branch_id = ? AND status IN ('COOKING','AWAITING_KITCHEN')`,
        [before.branch_id]
      );
      const queuePenalty = Math.min(15, Math.floor(Number(busy.c) / 3) * 2); // 2 phút mỗi 3 đơn
      etaMin = Math.ceil(leadMin + maxRemaining + queuePenalty);
    }

    await transitionOrder(req.params.id, OrderStatus.DELIVERING, {
      note: 'Đã gọi ĐVVC — ETA ~' + etaMin + ' phút',
      branchId: scope,
      role: req.user.role,
    });
    const shipId = 'SHIP-' + Date.now();
    await pool.execute(
      `INSERT INTO delivery_tracking (order_id, external_shipment_id, status, last_lat, last_lng)
       VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE external_shipment_id = VALUES(external_shipment_id),
       status = VALUES(status), last_lat = VALUES(last_lat), last_lng = VALUES(last_lng)`,
      [before.id, shipId, 'DELIVERING', Number(before.delivery_lat) || 0, Number(before.delivery_lng) || 0]
    );
    res.json({ ok: true, shipment_id: shipId, eta_minutes: etaMin });
  })
);

/* ===================== UC-30: Phiếu điều chỉnh tồn kho ===================== */

/**
 * Tự duyệt nếu chênh lệch <= ngưỡng (config %); nếu vượt → đẩy lên QL chuỗi (status=PENDING).
 */
router.post(
  '/inventory/adjust',
  B,
  asyncHandler(async (req, res) => {
    const { getNumberConfig } = require('../services/configService');
    const { checkAndEmitLowStockAlerts } = require('../services/inventoryService');
    const bid = req.user.branch_id;
    const { reason, lines } = req.body;
    if (!Array.isArray(lines) || !lines.length) return res.status(400).json({ error: 'Thiếu dòng điều chỉnh' });
    const thresholdPct = await getNumberConfig('inventory_adjust_auto_threshold_pct', 5);

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      let exceeds = false;
      const enriched = [];
      for (const l of lines) {
        const [[bi]] = await conn.execute(
          'SELECT quantity FROM branch_inventory WHERE branch_id = ? AND ingredient_id = ? FOR UPDATE',
          [bid, l.ingredient_id]
        );
        const before = bi ? Number(bi.quantity) : 0;
        const after = Number(l.qty_after);
        const delta = after - before;
        const pct = before > 0 ? Math.abs(delta) / before * 100 : (Math.abs(delta) > 0 ? 9999 : 0);
        if (pct > thresholdPct) exceeds = true;
        enriched.push({ ingredient_id: l.ingredient_id, qty_before: before, qty_after: after, delta });
      }
      const status = exceeds ? 'PENDING' : 'AUTO_APPROVED';
      const [ins] = await conn.execute(
        `INSERT INTO inventory_adjustments (branch_id, status, reason, created_by) VALUES (?,?,?,?)`,
        [bid, status, reason || null, req.user.id]
      );
      const adjId = ins.insertId;
      for (const e of enriched) {
        await conn.execute(
          `INSERT INTO inventory_adjustment_lines (adjustment_id, ingredient_id, qty_before, qty_after, delta) VALUES (?,?,?,?,?)`,
          [adjId, e.ingredient_id, e.qty_before, e.qty_after, e.delta]
        );
      }
      // Áp dụng ngay nếu auto-approve
      if (status === 'AUTO_APPROVED') {
        for (const e of enriched) {
          await conn.execute(
            'UPDATE branch_inventory SET quantity = ? WHERE branch_id = ? AND ingredient_id = ?',
            [e.qty_after, bid, e.ingredient_id]
          );
        }
      }
      await conn.commit();
      if (status === 'AUTO_APPROVED') {
        await checkAndEmitLowStockAlerts('BRANCH', bid, enriched.map(e => e.ingredient_id));
      }
      await logAudit(req.user.id, 'INV_ADJUST_CREATE', 'branch', { adjId, status, exceeds }, req.ip);
      res.json({ id: adjId, status, message: exceeds ? 'Chênh lệch vượt ngưỡng — đã gửi QL chuỗi duyệt' : 'Đã tự duyệt và áp dụng' });
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  })
);

router.get('/inventory/adjustments', B, async (req, res) => {
  const bid = req.user.branch_id;
  const [rows] = await pool.execute(
    `SELECT a.*, COUNT(l.id) AS line_count FROM inventory_adjustments a
     LEFT JOIN inventory_adjustment_lines l ON l.adjustment_id = a.id
     WHERE a.branch_id = ? GROUP BY a.id ORDER BY a.id DESC LIMIT 50`,
    [bid]
  );
  res.json({ adjustments: rows });
});

/* ===================== UC mới #1: Hao hụt thực phẩm ===================== */

router.post(
  '/orders/:id/mark-failed-delivery',
  B,
  asyncHandler(async (req, res) => {
    const orderId = Number(req.params.id);
    const { reason } = req.body;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[o]] = await conn.execute('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
      if (!o) { await conn.rollback(); return res.status(404).json({ error: 'Không tìm thấy' }); }
      if (o.status !== OrderStatus.DELIVERING && o.status !== OrderStatus.AWAITING_SHIPPER) {
        await conn.rollback(); return res.status(400).json({ error: 'Đơn không ở trạng thái có thể đánh dấu giao thất bại' });
      }
      // Tính tổng chi phí món + ghi waste
      const [items] = await conn.execute(
        `SELECT oi.*, p.base_price FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?`,
        [orderId]
      );
      let totalCost = 0;
      for (const it of items) totalCost += Number(it.unit_price) * Number(it.quantity);
      const [insW] = await conn.execute(
        `INSERT INTO food_waste (branch_id, order_id, reason, total_cost, created_by) VALUES (?,?,?,?,?)`,
        [o.branch_id, orderId, 'DELIVERY_FAILED', totalCost, req.user.id]
      );
      const wid = insW.insertId;
      for (const it of items) {
        await conn.execute(
          `INSERT INTO food_waste_lines (waste_id, product_id, quantity, unit_cost) VALUES (?,?,?,?)`,
          [wid, it.product_id, it.quantity, it.unit_price]
        );
      }
      // Chuyển trạng thái đơn → FAILED_DELIVERY, đánh dấu COD_FAILED nếu COD
      await conn.execute(
        `UPDATE orders SET status = ?, payment_status = CASE WHEN payment_method = 'COD' THEN 'COD_FAILED' ELSE payment_status END,
         cancel_reason = ? WHERE id = ?`,
        [OrderStatus.FAILED_DELIVERY, reason || 'Khách boom hàng', orderId]
      );
      await appendStatusHistory(conn, orderId, OrderStatus.FAILED_DELIVERY, reason || 'Giao thất bại - boom hàng');
      await conn.commit();
      await logAudit(req.user.id, 'ORDER_FAILED_DELIVERY', 'branch', { orderId, wasteId: wid, totalCost }, req.ip);
      res.json({ ok: true, waste_id: wid, total_cost: totalCost });
    } catch (e) {
      await conn.rollback(); throw e;
    } finally { conn.release(); }
  })
);

router.get('/food-waste', B, async (req, res) => {
  const bid = req.user.branch_id;
  const [rows] = await pool.execute(
    `SELECT w.*, o.order_code FROM food_waste w
     LEFT JOIN orders o ON o.id = w.order_id
     WHERE w.branch_id = ? ORDER BY w.id DESC LIMIT 100`,
    [bid]
  );
  res.json({ waste: rows });
});

/* ===================== UC mới #2: Mua hàng dự phòng (Local Purchase) ===================== */

router.post('/local-purchases', B, async (req, res) => {
  const bid = req.user.branch_id;
  const { ingredient_id, quantity, unit_price, vendor, receipt_no, note } = req.body;
  if (!ingredient_id || !quantity || quantity <= 0 || unit_price < 0) {
    return res.status(400).json({ error: 'Thiếu thông tin hoặc số liệu không hợp lệ' });
  }
  const totalCost = Number(quantity) * Number(unit_price);
  const conn = await pool.getConnection();
  const { checkAndEmitLowStockAlerts } = require('../services/inventoryService');
  try {
    await conn.beginTransaction();
    const [ins] = await conn.execute(
      `INSERT INTO local_purchases (branch_id, ingredient_id, quantity, unit_price, total_cost, vendor, receipt_no, note, created_by)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [bid, ingredient_id, quantity, unit_price, totalCost, vendor || null, receipt_no || null, note || null, req.user.id]
    );
    // Cập nhật ngay vào branch_inventory
    await conn.execute(
      `INSERT INTO branch_inventory (branch_id, ingredient_id, quantity) VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity)`,
      [bid, ingredient_id, quantity]
    );
    await conn.commit();
    await checkAndEmitLowStockAlerts('BRANCH', bid, [ingredient_id]);
    await logAudit(req.user.id, 'LOCAL_PURCHASE', 'branch', { id: ins.insertId, ingredient_id, totalCost }, req.ip);
    res.json({ id: ins.insertId, total_cost: totalCost });
  } catch (e) { await conn.rollback(); throw e; }
  finally { conn.release(); }
});

router.get('/local-purchases', B, async (req, res) => {
  const bid = req.user.branch_id;
  const [rows] = await pool.execute(
    `SELECT lp.*, i.name AS ingredient_name, i.unit FROM local_purchases lp
     JOIN ingredients i ON i.id = lp.ingredient_id
     WHERE lp.branch_id = ? ORDER BY lp.id DESC LIMIT 100`,
    [bid]
  );
  res.json({ purchases: rows });
});

/* ===================== UC mới #3: Đối soát tiền mặt theo ca ===================== */

router.post('/cash-shifts/open', B, async (req, res) => {
  const bid = req.user.branch_id;
  const { opening_cash } = req.body;
  // Chỉ cho 1 ca OPEN tại 1 thời điểm
  const [[opening]] = await pool.execute(
    `SELECT id FROM cash_shifts WHERE branch_id = ? AND status = 'OPEN' LIMIT 1`,
    [bid]
  );
  if (opening) return res.status(400).json({ error: 'Đang có ca mở — đóng ca trước', open_shift_id: opening.id });
  const [ins] = await pool.execute(
    `INSERT INTO cash_shifts (branch_id, opened_by, opening_cash) VALUES (?,?,?)`,
    [bid, req.user.id, Number(opening_cash) || 0]
  );
  await logAudit(req.user.id, 'CASH_SHIFT_OPEN', 'branch', { id: ins.insertId }, req.ip);
  res.json({ id: ins.insertId });
});

router.post('/cash-shifts/:id/close', B, async (req, res) => {
  const bid = req.user.branch_id;
  const { closing_cash, note } = req.body;
  const [[shift]] = await pool.execute(
    `SELECT * FROM cash_shifts WHERE id = ? AND branch_id = ?`,
    [req.params.id, bid]
  );
  if (!shift) return res.status(404).json({ error: 'Không tìm thấy ca' });
  if (shift.status === 'CLOSED') return res.status(400).json({ error: 'Ca đã đóng' });
  // Tính COD đã thu trong ca
  const [[cod]] = await pool.execute(
    `SELECT COALESCE(SUM(total),0) AS s FROM orders
     WHERE branch_id = ? AND payment_method = 'COD' AND payment_status = 'COD_COLLECTED'
     AND completed_at BETWEEN ? AND NOW()`,
    [bid, shift.opened_at]
  );
  const [[petty]] = await pool.execute(
    `SELECT COALESCE(SUM(total_cost),0) AS s FROM local_purchases
     WHERE branch_id = ? AND created_at BETWEEN ? AND NOW()`,
    [bid, shift.opened_at]
  );
  const expected = Number(shift.opening_cash) + Number(cod.s) - Number(petty.s);
  const variance = Number(closing_cash || 0) - expected;
  await pool.execute(
    `UPDATE cash_shifts SET status='CLOSED', closed_by=?, closed_at=NOW(),
     closing_cash=?, cod_collected=?, petty_cash_spent=?, expected_cash=?, variance=?, note=?
     WHERE id = ?`,
    [req.user.id, Number(closing_cash) || 0, cod.s, petty.s, expected, variance, note || null, req.params.id]
  );
  await logAudit(req.user.id, 'CASH_SHIFT_CLOSE', 'branch', { id: req.params.id, expected, variance }, req.ip);
  res.json({ ok: true, expected_cash: expected, cod_collected: Number(cod.s), petty_cash_spent: Number(petty.s), variance });
});

router.get('/cash-shifts', B, async (req, res) => {
  const bid = req.user.branch_id;
  const [rows] = await pool.execute(
    `SELECT cs.*, uo.full_name AS opener_name, uc.full_name AS closer_name FROM cash_shifts cs
     LEFT JOIN users uo ON uo.id = cs.opened_by
     LEFT JOIN users uc ON uc.id = cs.closed_by
     WHERE cs.branch_id = ? ORDER BY cs.id DESC LIMIT 50`,
    [bid]
  );
  res.json({ shifts: rows });
});

module.exports = router;
