const express = require('express');
const pool = require('../db');
const { auth } = require('../middleware/auth');
const { logAudit } = require('../lib/audit');
const { transitionOrder } = require('../services/orderService');
const { OrderStatus } = require('../domain/orderStatus');
const { asyncHandler } = require('../middleware/asyncHandler');

const router = express.Router();
const K = auth(['KITCHEN_STAFF', 'BRANCH_MANAGER', 'ADMIN']);

function branchFilter(req) {
  if (req.user.role === 'ADMIN') return req.query.branch_id || null;
  return req.user.branch_id;
}

router.get('/kds', K, async (req, res) => {
  const bid = branchFilter(req);
  if (!bid) return res.status(400).json({ error: 'Thiếu branch_id' });
  
  // 1. Lấy danh sách đơn hàng
  const [orders] = await pool.execute(
    `SELECT o.*, u.full_name AS customer_name FROM orders o
     JOIN users u ON u.id = o.user_id
     WHERE o.branch_id = ? AND o.status IN ('AWAITING_KITCHEN','COOKING','READY_PACKAGING')
     ORDER BY o.created_at`,
    [bid]
  );

  if (orders.length === 0) {
    return res.json({ orders: [] });
  }

  // 2. Lấy TẤT CẢ order_items của các đơn hàng trên trong 1 lần query (Giải quyết N+1)
  const orderIds = orders.map(o => o.id);
  const [items] = await pool.query(
    `SELECT * FROM order_items WHERE order_id IN (?)`,
    [orderIds]
  );

  // 3. Gắn items vào từng order tương ứng
  const ordersWithItems = orders.map(o => {
    return {
      ...o,
      items: items.filter(item => Number(item.order_id) === Number(o.id))
    };
  });

  res.json({ orders: ordersWithItems });
});

/**
 * UC-33: Tách "Xác nhận nhận đơn" và "Bắt đầu nấu" thành 2 bước.
 * - acknowledge: ghi `kitchen_ack_at` để đo thời gian phản hồi của bếp, không đổi state.
 * - start: chuyển AWAITING_KITCHEN → COOKING.
 */
/**
 * UC-33: Tách "Xác nhận nhận đơn" và "Bắt đầu nấu" thành 2 bước.
 */
router.post(
  '/orders/:id/acknowledge',
  K,
  asyncHandler(async (req, res) => {
    const bid = branchFilter(req);
    const [[o]] = await pool.execute('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!o) return res.status(404).json({ error: 'Không tìm thấy' });
    if (req.user.role !== 'ADMIN' && Number(o.branch_id) !== Number(bid)) {
      return res.status(403).json({ error: 'Không thuộc chi nhánh bạn' });
    }
    // ĐÃ FIX TEXT TRỰC TIẾP
    if (o.status !== 'AWAITING_KITCHEN') {
      return res.status(400).json({ error: 'Đơn không ở trạng thái chờ bếp' });
    }
    if (o.kitchen_ack_at) return res.json({ ok: true, already: true });
    await pool.execute('UPDATE orders SET kitchen_ack_at = NOW() WHERE id = ?', [req.params.id]);
    await logAudit(req.user.id, 'KITCHEN_ACK', 'kitchen', { orderId: req.params.id }, req.ip);
    res.json({ ok: true });
  })
);

router.post(
  '/orders/:id/start',
  K,
  asyncHandler(async (req, res) => {
    const bid = branchFilter(req);
    if (req.user.role !== 'ADMIN' && !bid) {
      return res.status(400).json({ error: 'Thiếu branch_id (query ?branch_id= cho KDS)' });
    }
    // ĐÃ FIX TEXT TRỰC TIẾP
    await transitionOrder(req.params.id, 'COOKING', {
      note: 'Bếp bắt đầu chế biến',
      branchId: bid,
      role: req.user.role,
    });
    await pool.execute('UPDATE orders SET kitchen_ack_at = COALESCE(kitchen_ack_at, NOW()) WHERE id = ?', [req.params.id]);
    await pool.execute(
      `UPDATE order_items SET cook_status = 'COOKING', cook_started_at = COALESCE(cook_started_at, NOW())
       WHERE order_id = ? AND cook_status = 'PENDING'`,
      [req.params.id]
    );
    await logAudit(req.user.id, 'KITCHEN_START', 'kitchen', { orderId: req.params.id }, req.ip);
    res.json({ ok: true });
  })
);

/**
 * UC-34: Chuyển từng món ra trạm chờ đóng gói (per-item).
 */
router.patch(
  '/orders/:orderId/items/:itemId/cook-status',
  K,
  asyncHandler(async (req, res) => {
    const { cook_status } = req.body;
    if (!['PENDING', 'COOKING', 'READY'].includes(cook_status)) {
      return res.status(400).json({ error: 'cook_status không hợp lệ' });
    }
    const bid = branchFilter(req);
    
    // ĐÃ FIX TEXT TRỰC TIẾP
    const [[orderRow]] = await pool.execute('SELECT status FROM orders WHERE id = ?', [req.params.orderId]);
    if (!orderRow || orderRow.status !== 'COOKING') {
      return res.status(400).json({ error: 'Đơn hàng chưa bắt đầu nấu hoặc đã qua khâu đóng gói' });
    }

    const [[item]] = await pool.execute(
      `SELECT oi.*, o.branch_id AS order_branch FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE oi.id = ? AND oi.order_id = ?`,
      [req.params.itemId, req.params.orderId]
    );
    if (!item) return res.status(404).json({ error: 'Không tìm thấy món trong đơn' });
    if (req.user.role !== 'ADMIN' && Number(item.order_branch) !== Number(bid)) {
      return res.status(403).json({ error: 'Không thuộc chi nhánh bạn' });
    }
    
    const finishedAt = cook_status === 'READY' ? 'cook_finished_at = NOW(), ' : '';
    const startedAt = cook_status === 'COOKING' ? 'cook_started_at = COALESCE(cook_started_at, NOW()), ' : '';
    await pool.execute(
      `UPDATE order_items SET ${startedAt}${finishedAt}cook_status = ? WHERE id = ?`,
      [cook_status, req.params.itemId]
    );
    
    if (cook_status === 'READY') {
      const [[remain]] = await pool.execute(
        `SELECT COUNT(*) AS c FROM order_items WHERE order_id = ? AND cook_status != 'READY'`,
        [req.params.orderId]
      );
      if (Number(remain.c) === 0) {
        // ĐÃ FIX TEXT TRỰC TIẾP
        await transitionOrder(req.params.orderId, 'READY_PACKAGING', {
          note: 'Tất cả món đã sẵn sàng (UC-34)',
          branchId: bid,
          role: req.user.role,
        });
      }
    }
    res.json({ ok: true });
  })
);

router.post(
  '/orders/:id/finish-cook',
  K,
  asyncHandler(async (req, res) => {
    const bid = branchFilter(req);
    // ĐÃ FIX TEXT TRỰC TIẾP
    const [[orderRow]] = await pool.execute('SELECT status FROM orders WHERE id = ?', [req.params.id]);
    if (!orderRow || orderRow.status !== 'COOKING') {
      return res.status(400).json({ error: 'Chỉ có thể hoàn thành khi đơn đang được nấu' });
    }

    await pool.execute(
      `UPDATE order_items SET cook_status = 'READY', cook_finished_at = COALESCE(cook_finished_at, NOW())
       WHERE order_id = ?`,
      [req.params.id]
    );
    // ĐÃ FIX TEXT TRỰC TIẾP
    await transitionOrder(req.params.id, 'READY_PACKAGING', {
      note: 'Đã nấu xong toàn bộ',
      branchId: bid,
      role: req.user.role,
    });
    res.json({ ok: true });
  })
);

router.post(
  '/orders/:id/package',
  K,
  asyncHandler(async (req, res) => {
    const bid = branchFilter(req);
    // ĐÃ FIX TEXT TRỰC TIẾP
    const [[orderRow]] = await pool.execute('SELECT status FROM orders WHERE id = ?', [req.params.id]);
    if (!orderRow || orderRow.status !== 'READY_PACKAGING') {
      return res.status(400).json({ error: 'Đơn chưa sẵn sàng để đóng gói' });
    }

    // ĐÃ FIX TEXT TRỰC TIẾP
    await transitionOrder(req.params.id, 'AWAITING_SHIPPER', {
      note: 'Đã đóng gói — chờ shipper',
      branchId: bid,
      role: req.user.role,
    });
    res.json({ ok: true });
  })
);

// ĐÃ BỌC TRANSACTION VÀ RÚT GỌN CỘT LỊCH SỬ ĐỂ CHỐNG CRASH
router.post(
  '/orders/:id/revert-to-cook',
  K,
  asyncHandler(async (req, res) => {
    const { reason } = req.body;
    
    const [[orderRow]] = await pool.execute('SELECT status FROM orders WHERE id = ?', [req.params.id]);
    if (!orderRow || orderRow.status !== 'READY_PACKAGING') {
      return res.status(400).json({ error: 'Chỉ có thể báo lỗi khi đơn đang ở khu vực chờ đóng gói' });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // 1. Kéo đơn về COOKING
      await conn.execute(
        'UPDATE orders SET status = ? WHERE id = ?',
        ['COOKING', req.params.id]
      );

      // 2. Ghi lịch sử cơ bản (Tránh truyền thừa cột gây lỗi)
      await conn.execute(
        'INSERT INTO order_status_history (order_id, status, note) VALUES (?, ?, ?)',
        [req.params.id, 'COOKING', reason || 'Sai sót đóng gói - Quay lại bếp']
      );

      // 3. Reset toàn bộ món ăn về COOKING để có thể bấm Xong lại
      await conn.execute(
        `UPDATE order_items SET cook_status = 'COOKING' WHERE order_id = ?`,
        [req.params.id]
      );

      await conn.commit();
      res.json({ ok: true });
    } catch (e) {
      await conn.rollback(); // Lỗi thì quay xe, không update nửa vời
      throw e;
    } finally {
      conn.release();
    }
  })
);
// Lịch sử đơn hàng đã hoàn thành hoặc bị hủy để tiện tra cứu (Không show đơn đang nấu vì có thể rất nhiều)
router.get('/history', K, async (req, res) => {
  const bid = branchFilter(req);
  if (!bid) return res.status(400).json({ error: 'Thiếu branch_id' });
  const [orders] = await pool.execute(
    `SELECT o.*, u.full_name AS customer_name FROM orders o
     JOIN users u ON u.id = o.user_id
     WHERE o.branch_id = ? AND o.status IN ('COMPLETED', 'CANCELLED', 'FAILED_DELIVERY')
     ORDER BY o.created_at DESC LIMIT 100`,
    [bid]
  );
  res.json({ orders });
});

module.exports = router;