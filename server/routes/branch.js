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
    
    // Kiểm tra trạng thái đơn trước khi confirm 
    const [[order]] = await pool.execute('SELECT status, branch_id FROM orders WHERE id = ?', [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Đơn hàng không tồn tại' });
    if (order.status !== 'PENDING_BRANCH') {
      return res.status(400).json({ error: 'Đơn hàng đã được xử lý hoặc không thể xác nhận lúc này' });
    }

    await transitionOrder(req.params.id, OrderStatus.AWAITING_KITCHEN, {
      note: 'Chi nhánh xác nhận',
      branchId: scope,
      role: req.user.role,
    });
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

// ==========================================
// KHU VỰC KDS (KITCHEN DISPLAY SYSTEM) - UC-33 & UC-34
// ==========================================

// UC-33: Lấy danh sách các món đang chờ nấu tại bếp (Gộp theo đơn)
router.get('/kitchen/queue', B, async (req, res) => {
  const bid = req.user.branch_id;
  const [items] = await pool.execute(
    `SELECT oi.*, o.order_code, o.status as order_status 
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE o.branch_id = ? AND o.status IN ('AWAITING_KITCHEN', 'COOKING')
       AND oi.cook_status IN ('PENDING', 'COOKING')
     ORDER BY o.created_at ASC`,
    [bid]
  );
  res.json({ queue: items });
});

// UC-33: Nhân viên bếp bấm "Bắt đầu nấu" 1 món cụ thể
router.post('/kitchen/items/:itemId/start', B, async (req, res) => {
  const itemId = req.params.itemId;
  
  // Chuyển trạng thái món
  await pool.execute(
    `UPDATE order_items SET cook_status = 'COOKING', cook_started_at = NOW() 
     WHERE id = ? AND cook_status = 'PENDING'`,
    [itemId]
  );
  
  // Nếu đây là món đầu tiên của đơn được nấu, tự động chuyển đơn sang COOKING
  const [[item]] = await pool.execute('SELECT order_id FROM order_items WHERE id = ?', [itemId]);
  if (item) {
     await pool.execute(
       `UPDATE orders SET status = 'COOKING', kitchen_started_at = COALESCE(kitchen_started_at, NOW()) 
        WHERE id = ? AND status = 'AWAITING_KITCHEN'`, 
       [item.order_id]
     );
  }
  
  res.json({ ok: true, message: 'Đã bắt đầu nấu món' });
});

// UC-34: Nhân viên bếp bấm "Xong" 1 món (Chuyển ra khâu đóng gói)
router.post('/kitchen/items/:itemId/ready', B, async (req, res) => {
  const itemId = req.params.itemId;
  
  await pool.execute(
    `UPDATE order_items SET cook_status = 'READY', cook_finished_at = NOW() WHERE id = ?`,
    [itemId]
  );

  // Mở rộng logic: Bạn có thể thêm đoạn code kiểm tra xem nều TẤT CẢ các món trong 
  // đơn này đã 'READY' thì chuyển đơn sang trạng thái 'AWAITING_SHIPPER'
  
  res.json({ ok: true, message: 'Đã chuyển món ra quầy đóng gói' });
});

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

router.post('/cash-shifts/close-current', B, asyncHandler(async (req, res) => {
  const bid = req.user.branch_id;
  const { closing_cash, note } = req.body;

  // Tự tìm ca đang OPEN của chi nhánh 
  const [[shift]] = await pool.execute(
    `SELECT * FROM cash_shifts WHERE branch_id = ? AND status = 'OPEN' LIMIT 1`,
    [bid]
  );
  if (!shift) return res.status(404).json({ error: 'Không tìm thấy ca nào đang mở' });

  // Logic tính toán COD và Petty Cash (giữ nguyên như bạn đã viết rất tốt)
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
    [req.user.id, Number(closing_cash) || 0, cod.s, petty.s, expected, variance, note || null, shift.id]
  );

  res.json({ ok: true, expected_cash: expected, cod_collected: Number(cod.s), petty_cash_spent: Number(petty.s), variance });
}));

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

// =========================================================
// BỔ SUNG UC-30: CHI NHÁNH NHẬN HÀNG TỪ KHO TỔNG
// =========================================================
// UC-30: Lấy chi tiết chuyến hàng đang đến (để chi nhánh kiểm đếm)
router.get('/outbounds/:id', B, async (req, res) => {
  const bid = req.user.branch_id;
  const [[ob]] = await pool.execute(
    `SELECT o.* FROM stock_outbounds o 
     JOIN stock_requests sr ON sr.id = o.stock_request_id
     WHERE o.id = ? AND sr.branch_id = ?`,
    [req.params.id, bid]
  );
  if (!ob) return res.status(404).json({ error: 'Không tìm thấy phiếu xuất' });

  const [lines] = await pool.execute(
    `SELECT sol.*, i.name, i.unit FROM stock_outbound_lines sol
     JOIN ingredients i ON i.id = sol.ingredient_id WHERE sol.stock_outbound_id = ?`,
    [ob.id]
  );
  res.json({ outbound: ob, lines });
});

// UC-30: Nhận hàng có kiểm đếm thực tế
// UC-30: Nhận hàng có kiểm đếm thực tế (Bản có kèm Ghi chú/Phản hồi)
router.post('/outbounds/:id/receive', B, asyncHandler(async (req, res) => {
  const bid = req.user.branch_id;
  // Bổ sung nhận thêm trường 'note' từ Frontend
  const { received_lines, note } = req.body; 
  const conn = await pool.getConnection();
  
  try {
    await conn.beginTransaction();

    const [[ob]] = await conn.execute(
      `SELECT o.*, sr.branch_id, sr.id as request_id 
       FROM stock_outbounds o
       JOIN stock_requests sr ON sr.id = o.stock_request_id
       WHERE o.id = ? FOR UPDATE`, [req.params.id]
    );

    if (!ob || Number(ob.branch_id) !== Number(bid)) throw new Error('Phiếu không hợp lệ');
    if (ob.status !== 'SHIPPED') throw new Error('Phiếu không ở trạng thái đang giao');

    const [shippedLines] = await conn.execute('SELECT * FROM stock_outbound_lines WHERE stock_outbound_id = ?', [ob.id]);
    let hasDiscrepancy = false;
    const discrepancies = [];

    for (const sLine of shippedLines) {
      const rLine = received_lines.find(l => l.ingredient_id === sLine.ingredient_id);
      const actualQty = rLine ? Number(rLine.qty_received) : 0;

      await conn.execute(
        `INSERT INTO branch_inventory (branch_id, ingredient_id, quantity) 
         VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity)`,
        [bid, sLine.ingredient_id, actualQty]
      );

      if (actualQty !== Number(sLine.quantity)) {
        hasDiscrepancy = true;
        discrepancies.push({
          ingredient_id: sLine.ingredient_id,
          shipped: sLine.quantity,
          received: actualQty
        });
      }
    }

    await conn.execute(`UPDATE stock_outbounds SET status = 'DELIVERED' WHERE id = ?`, [ob.id]);
    await conn.execute(`UPDATE stock_requests SET status = 'COMPLETED' WHERE id = ?`, [ob.request_id]);

    // LƯU GHI CHÚ PHẢN HỒI VÀO AUDIT LOG
    if (hasDiscrepancy) {
      await logAudit(req.user.id, 'RECEIVE_DISCREPANCY', 'branch', 
        { outbound_id: ob.id, note: note || 'Nhận thiếu/thừa hàng', details: discrepancies }, req.ip);
    } else {
      await logAudit(req.user.id, 'RECEIVE_STOCK', 'branch', 
        { outbound_id: ob.id, note: note || 'Nhận đủ hàng' }, req.ip);
    }

    await conn.commit();
    res.json({ ok: true, has_discrepancy: hasDiscrepancy });

  } catch (e) {
    await conn.rollback();
    res.status(400).json({ error: e.message });
  } finally {
    conn.release();
  }
}));

// API UC-30: Báo cáo sự cố chuyến hàng từ phía Chi nhánh
router.post('/outbounds/:id/report-issue', B, asyncHandler(async (req, res) => {
  const bid = req.user.branch_id;
  const { reason } = req.body;

  const [[ob]] = await pool.execute(
    `SELECT o.*, sr.branch_id 
     FROM stock_outbounds o
     JOIN stock_requests sr ON sr.id = o.stock_request_id
     WHERE o.id = ?`, [req.params.id]
  );

  if (!ob || Number(ob.branch_id) !== Number(bid)) {
    return res.status(404).json({ error: 'Không tìm thấy thông tin chuyến hàng' });
  }

  await logAudit(req.user.id, 'STOCK_DELIVERY_ISSUE', 'branch', 
    { outbound_id: ob.id, outbound_code: ob.code, reason: reason }, req.ip);

  await pool.execute(
    `UPDATE stock_requests SET status = 'ISSUE', reject_reason = ? WHERE id = ?`,
    [`Sự cố vận chuyển: ${reason}`, ob.stock_request_id]
  );

  res.json({ ok: true, message: 'Đã ghi nhận sự cố' });
}));
// =========================================================
// UC-29: QUẢN LÝ NHÂN SỰ CHI NHÁNH
// =========================================================
router.get('/staff', B, async (req, res) => {
  const bid = req.user.branch_id;
  const [rows] = await pool.execute(
    `SELECT u.id, u.full_name, u.phone, u.email, u.is_active, r.name_vi as role_name
     FROM users u
     JOIN roles r ON u.role_id = r.id
     WHERE u.branch_id = ? AND u.is_deleted = 0 ORDER BY u.id DESC`,
    [bid]
  );
  
  // Lấy thêm danh sách vai trò cho form thêm nhân viên (Chỉ lấy vai trò Bếp, Shipper, Thu ngân...)
  const [roles] = await pool.execute(`SELECT id, code, name_vi FROM roles WHERE code != 'ADMIN' AND code != 'CHAIN_MANAGER'`);
  res.json({ staff: rows, roles });
});

router.post('/staff', B, asyncHandler(async (req, res) => {
  const bid = req.user.branch_id;
  const { full_name, phone, email, password, role_id } = req.body;
  
  if (!full_name || !phone || !password || !role_id) {
    return res.status(400).json({ error: 'Vui lòng điền đủ các trường bắt buộc' });
  }

  const bcrypt = require('bcrypt');
  const hash = await bcrypt.hash(password, 10);

  const [ins] = await pool.execute(
    `INSERT INTO users (full_name, phone, email, password_hash, branch_id, role_id, is_active, must_change_password)
     VALUES (?, ?, ?, ?, ?, ?, 1, 1)`,
    [full_name, phone, email || null, hash, bid, role_id]
  );
  
  await logAudit(req.user.id, 'STAFF_CREATE', 'branch', { target_id: ins.insertId }, req.ip);
  res.json({ ok: true, id: ins.insertId });
}));

// =========================================================
// LẤY DANH SÁCH HÀNG ĐANG VẬN CHUYỂN TỚI CHI NHÁNH
// =========================================================
router.get('/incoming-stock', B, asyncHandler(async (req, res) => {
  const bid = req.user.branch_id;
  
  // Chỉ lấy những phiếu xuất (outbounds) đang ở trạng thái SHIPPED
  // và thuộc về phiếu xin hàng (stock_requests) của chính chi nhánh này
  const [outbounds] = await pool.execute(
    `SELECT o.*, sr.branch_id 
     FROM stock_outbounds o
     JOIN stock_requests sr ON sr.id = o.stock_request_id
     WHERE sr.branch_id = ? AND o.status = 'SHIPPED'
     ORDER BY o.id DESC`,
    [bid]
  );
  
  res.json({ outbounds });
}));

// ==========================================
// BACKGROUND JOB: UC-31 TỰ ĐỘNG BẬT LẠI MÓN
// ==========================================
// Chạy ngầm mỗi 60 giây để quét và tự động bật lại món khi hết thời gian hẹn
setInterval(async () => {
  try {
    const [rows] = await pool.execute(
      `SELECT branch_id, product_id FROM branch_menu 
       WHERE manual_off = 1 AND manual_off_until IS NOT NULL AND manual_off_until <= NOW()`
    );
    
    if (rows.length > 0) {
      // Cập nhật database: Tắt cờ manual_off, xóa lý do và thời gian hẹn
      await pool.execute(
        `UPDATE branch_menu 
         SET manual_off = 0, manual_off_reason = NULL, manual_off_until = NULL 
         WHERE manual_off = 1 AND manual_off_until IS NOT NULL AND manual_off_until <= NOW()`
      );
      
      console.log(`[UC-31] Đã tự động bật lại ${rows.length} món ăn đã hết thời gian tạm tắt.`);
      // Tùy chọn: Bạn có thể gọi thêm emit Socket.IO ở đây để update UI khách hàng real-time
    }
  } catch (e) {
    console.error('[UC-31 Cron Error]', e);
  }
}, 60000);

// ==========================================
// BACKGROUND JOB: UC-36 TỰ ĐỘNG GỌI SHIPPER
// ==========================================
// Chạy ngầm mỗi 30 giây để quét các đơn đang nấu và tính toán gọi xe
setInterval(async () => {
  try {
    // 1. Lấy các đơn đang ở trạng thái nấu mà CHƯA có mã chuyến vận chuyển
    const [orders] = await pool.execute(
      `SELECT o.id, o.branch_id, o.kitchen_started_at
       FROM orders o
       LEFT JOIN delivery_tracking dt ON o.id = dt.order_id
       WHERE o.status = 'COOKING' AND dt.external_shipment_id IS NULL`
    );

    for (const order of orders) {
      // 2. Lấy thời gian chuẩn bị (prep_time) của từng món trong đơn
      const [items] = await pool.execute(
        `SELECT oi.cook_status, p.prep_time_minutes
         FROM order_items oi
         JOIN products p ON p.id = oi.product_id
         WHERE oi.order_id = ?`, [order.id]
      );

      let maxRemaining = 0;
      let allReady = true;

      // 3. Tính toán xem món nào tốn thời gian nấu lâu nhất
      for (const it of items) {
        if (it.cook_status !== 'READY') {
          allReady = false;
          const elapsed = order.kitchen_started_at ? Math.max(0, (Date.now() - new Date(order.kitchen_started_at).getTime()) / 60000) : 0;
          const remain = Math.max(0, Number(it.prep_time_minutes) - elapsed);
          if (remain > maxRemaining) maxRemaining = remain;
        }
      }

      // 4. Nếu thời gian nấu còn lại <= 5 phút (Lead time dự kiến shipper di chuyển tới) hoặc tất cả đã nấu xong
      const LEAD_TIME = 5; 
      if (allReady || maxRemaining <= LEAD_TIME) {
        // Giả lập gọi API đối tác vận chuyển (UC-41)
        const shipId = 'AUTO-SHIP-' + Date.now();
        
        // Tạo tracking và tự động chuyển trạng thái để báo hiệu đang tìm tài xế
        await pool.execute(
          `INSERT INTO delivery_tracking (order_id, external_shipment_id, status)
           VALUES (?, ?, 'LOOKING_FOR_DRIVER')`, [order.id, shipId]
        );
        
        console.log(`[UC-36] Đã tự động gọi Shipper cho đơn ${order.id}. Khớp ETA chuẩn!`);
      }
    }
  } catch (e) {
    console.error('[UC-36 Cron Error]', e);
  }
}, 30000);

module.exports = router;
