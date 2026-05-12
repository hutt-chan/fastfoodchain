const pool = require('./db'); // Điều chỉnh đường dẫn tới file db.js nếu cần
const { transitionOrder } = require('./services/orderService');
const { refreshBranchProductAvailability } = require('./services/inventoryService');
const { getNumberConfig } = require('./services/configService');

/**
 * UC-36: TỰ ĐỘNG GỌI TÀI XẾ (Cron Job)
 * Tính toán thời gian: Nếu món sắp xong (nhỏ hơn lead_time của Shipper), thì gọi API Shipper.
 */
async function autoDispatchShippers() {
  const conn = await pool.getConnection();
  try {
    // Lấy thời gian Shipper di chuyển từ cấu hình (Mặc định 5 phút)
    const leadMin = await getNumberConfig('dispatch_lead_time_min', 5);

    // Lấy các đơn hàng đang chuẩn bị (hoặc đóng gói xong) nhưng chưa gọi Shipper
    const [orders] = await conn.execute(
      `SELECT o.id, o.kitchen_started_at, o.status, o.branch_id 
       FROM orders o
       LEFT JOIN delivery_tracking dt ON dt.order_id = o.id
       WHERE o.status IN ('COOKING', 'READY_PACKAGING') 
         AND dt.external_shipment_id IS NULL`
    );

    for (const o of orders) {
      // 1. Nếu đã đóng gói xong -> Gọi Shipper NGAY
      if (o.status === 'READY_PACKAGING') {
        await dispatchDelivery(conn, o.id, o.branch_id, 0);
        continue;
      }

      // 2. Nếu đang nấu -> Tính max(thời gian nấu còn lại)
      const [items] = await conn.execute(
        `SELECT oi.cook_status, p.prep_time_minutes 
         FROM order_items oi 
         JOIN products p ON p.id = oi.product_id 
         WHERE oi.order_id = ?`,
        [o.id]
      );

      let maxRemaining = 0;
      const elapsed = o.kitchen_started_at ? Math.max(0, (Date.now() - new Date(o.kitchen_started_at).getTime()) / 60000) : 0;

      for (const it of items) {
        if (it.cook_status === 'READY') continue;
        const remain = Math.max(0, Number(it.prep_time_minutes) - elapsed);
        if (remain > maxRemaining) maxRemaining = remain;
      }

      // Nếu thời gian nấu còn lại <= thời gian Shipper di chuyển tới -> Gọi ngay để Shipper đến lấy là vừa nóng
      if (maxRemaining <= leadMin) {
        await dispatchDelivery(conn, o.id, o.branch_id, maxRemaining);
      }
    }
  } catch (error) {
    console.error('[UC-36] Lỗi khi chạy Auto Dispatch:', error);
  } finally {
    conn.release();
  }
}

// Hàm hỗ trợ đổi trạng thái và tạo Tracking
async function dispatchDelivery(conn, orderId, branchId, etaCooking) {
  const shipmentId = 'SHIP-' + Date.now();
  console.log(`[UC-36] Đang gọi Shipper cho Đơn #${orderId} (ETA Bếp: ${Math.round(etaCooking)} phút)`);

  // Lưu Tracking
  await conn.execute(
    `INSERT INTO delivery_tracking (order_id, external_shipment_id, status) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE external_shipment_id = VALUES(external_shipment_id), status = VALUES(status)`,
    [orderId, shipmentId, 'FINDING_DRIVER']
  );

  // Đổi trạng thái đơn hàng dùng hàm chuẩn trong orderService
  await transitionOrder(orderId, 'AWAITING_SHIPPER', {
    note: `Hệ thống tự động gọi ĐVVC (Lead time). Mã chuyến: ${shipmentId}`,
    branchId: branchId,
    role: 'SYSTEM',
  });
}

/**
 * UC-31: Quét định kỳ để bật lại món đã hết giờ khóa (Auto Resume)
 */
async function autoResumeMenuItems() {
  try {
    // Tìm các chi nhánh đang có món hẹn giờ bật lại và giờ đó đã qua
    const [rows] = await pool.execute(
      `SELECT DISTINCT branch_id 
       FROM branch_menu 
       WHERE manual_off = 1 AND manual_off_until IS NOT NULL AND manual_off_until <= NOW()`
    );

    for (const r of rows) {
      // Hàm refresh này (của bạn) đã có sẵn lệnh UPDATE manual_off = 0 bên trong!
      await refreshBranchProductAvailability(r.branch_id);
      console.log(`[UC-31] Đã quét và auto-resume menu cho Chi nhánh #${r.branch_id}`);
    }
  } catch (error) {
    console.error('[UC-31] Lỗi Auto Resume Menu:', error);
  }
}

// Khởi chạy tiến trình
function startCronJobs() {
  console.log('🚀 Background Jobs đang chạy (UC-31, UC-36)...');
  
  // Chạy mỗi 30 giây
  setInterval(() => {
    autoDispatchShippers();
    autoResumeMenuItems();
  }, 30000); 
}

module.exports = { startCronJobs };