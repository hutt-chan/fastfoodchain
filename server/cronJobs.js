const pool = require('./db');
const { transitionOrder } = require('./services/orderService');
const { refreshBranchProductAvailability } = require('./services/inventoryService');
const { getNumberConfig } = require('./services/configService');

// 1. TÍNH TOÁN GỌI XE TRƯỚC KHI NẤU XONG
async function autoDispatchShippers() {
  const conn = await pool.getConnection();
  try {
    const leadMin = await getNumberConfig('dispatch_lead_time_min', 5);

    // Lấy các đơn đang NẤU hoặc CHỜ ĐÓNG GÓI mà CHƯA có mã chuyến xe
    const [orders] = await conn.execute(
      `SELECT o.id, o.kitchen_started_at, o.status, o.branch_id 
       FROM orders o
       LEFT JOIN delivery_tracking dt ON dt.order_id = o.id
       WHERE o.status IN ('COOKING', 'READY_PACKAGING') 
         AND dt.external_shipment_id IS NULL`
    );

    for (const o of orders) {
      if (o.status === 'READY_PACKAGING') {
        await dispatchDelivery(conn, o.id, o.branch_id, 0);
        continue;
      }

      // Tính max thời gian nấu còn lại
      const [items] = await conn.execute(
        `SELECT oi.cook_status, p.prep_time_minutes 
         FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?`, [o.id]
      );

      let maxRemaining = 0;
      const elapsed = o.kitchen_started_at ? Math.max(0, (Date.now() - new Date(o.kitchen_started_at).getTime()) / 60000) : 0;

      for (const it of items) {
        if (it.cook_status === 'READY') continue;
        const remain = Math.max(0, Number(it.prep_time_minutes) - elapsed);
        if (remain > maxRemaining) maxRemaining = remain;
      }

      // Đạt điểm gọi tài xế (VD: còn <= 5 phút nữa là xong)
      if (maxRemaining <= leadMin && maxRemaining > 0) {
        await dispatchDelivery(conn, o.id, o.branch_id, maxRemaining);
      }
    }
  } catch (error) { console.error('[UC-36] Lỗi Auto Dispatch:', error); } 
  finally { conn.release(); }
}

async function dispatchDelivery(conn, orderId, branchId, etaCooking) {
  const shipmentId = 'SHIP-' + Date.now();
  console.log(`[UC-36] Đang gọi xe cho Đơn #${orderId} (ETA Bếp: ${Math.round(etaCooking)} phút)`);

  // CHỈ ghi nhận tracking tìm tài xế, KHÔNG đổi status của order (Đơn vẫn đang nấu)
  await conn.execute(
    `INSERT INTO delivery_tracking (order_id, external_shipment_id, status) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE external_shipment_id = VALUES(external_shipment_id), status = VALUES(status)`,
    [orderId, shipmentId, 'DRIVER_ON_WAY']
  );
  
  // Ghi log vào lịch sử để Quản lý biết hệ thống đã gọi xe
  await conn.execute(
    `INSERT INTO order_status_history (order_id, status, note) VALUES (?, ?, ?)`,
    [orderId, 'SYSTEM_LOG', `Hệ thống tự gọi ĐVVC. Mã chuyến: ${shipmentId}`]
  );
}

// 2. GIẢ LẬP SHIPPER (MOCK WEBHOOK)
async function mockShipperActions() {
  const conn = await pool.getConnection();
  try {
    // Nếu Bếp đã đóng gói xong (AWAITING_SHIPPER) VÀ Tài xế đang đến (DRIVER_ON_WAY) 
    // -> Giả lập tài xế bốc hàng đi -> Chuyển thành DELIVERING
    const [readyToPick] = await conn.execute(`
       SELECT o.id, o.branch_id FROM orders o 
       JOIN delivery_tracking dt ON o.id = dt.order_id 
       WHERE o.status = 'AWAITING_SHIPPER' AND dt.status = 'DRIVER_ON_WAY'
    `);
    
    for (const o of readyToPick) {
       console.log(`[Mock Shipper] Tài xế đã lấy Đơn #${o.id}. Đang giao hàng!`);
       await transitionOrder(o.id, 'DELIVERING', { note: 'Tài xế đã lấy hàng (Mock Webhook)', branchId: o.branch_id, role: 'SYSTEM' });
       await conn.execute(`UPDATE delivery_tracking SET status = 'DELIVERING' WHERE order_id = ?`, [o.id]);
    }
  } catch(e) { console.error(e); } 
  finally { conn.release(); }
}

function startCronJobs() {
  console.log('🚀 Background Jobs đang chạy...');
  setInterval(() => {
    autoDispatchShippers();
    mockShipperActions(); // Thêm giả lập vào vòng lặp
    // autoResumeMenuItems(); // Bật lại món (giữ nguyên của bạn)
  }, 15000); // Chạy 15s/lần cho mượt
}
module.exports = { startCronJobs };