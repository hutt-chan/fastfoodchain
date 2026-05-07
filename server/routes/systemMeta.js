const express = require('express');
const { ORDER_TRANSITIONS, OrderStatus, PaymentStatus } = require('../domain/orderStatus');

const router = express.Router();

/** Mô tả máy trạng thái đơn + endpoint */
router.get('/meta', (req, res) => {
  res.json({
    order_statuses: Object.values(OrderStatus),
    payment_statuses: Object.values(PaymentStatus),
    order_transitions: ORDER_TRANSITIONS,
    endpoints: {
      auth: ['POST /api/auth/login', 'POST /api/auth/register', 'GET /api/auth/me', 'PATCH /api/auth/profile|password'],
      customer: [
        'GET /api/branches', 'GET /api/branches/:id/menu',
        'GET|POST|PATCH|DELETE /api/cart/items',
        'POST /api/vouchers/validate',
        'POST /api/orders', 'GET /api/orders[/:id]',
        'POST /api/orders/:id/cancel|review|after-online-pay',
      ],
      branch: [
        'GET /api/branch/dashboard|orders[/:id]|menu|inventory|reports|ingredients|stock-requests',
        'POST /api/branch/orders/:id/confirm|dispatch-delivery|mark-failed-delivery',
        'POST /api/branch/stock-requests',
        'POST /api/branch/inventory/adjust  (UC-30)',
        'GET /api/branch/inventory/adjustments',
        'POST /api/branch/local-purchases  (UC mới #2)',
        'GET /api/branch/local-purchases',
        'POST /api/branch/cash-shifts/open  (UC mới #3)',
        'POST /api/branch/cash-shifts/:id/close',
        'GET /api/branch/cash-shifts',
        'GET /api/branch/food-waste',
      ],
      kitchen: [
        'GET /api/kitchen/kds',
        'POST /api/kitchen/orders/:id/acknowledge  (UC-33)',
        'POST /api/kitchen/orders/:id/start|finish-cook|package',
        'PATCH /api/kitchen/orders/:orderId/items/:itemId/cook-status  (UC-34)',
      ],
      chain: [
        'GET|POST /api/chain/categories|products|ingredients|vouchers',
        'PATCH|DELETE /api/chain/products/:id  (UC-15 soft delete)',
        'POST /api/chain/products/:id/restore',
        'GET|PUT /api/chain/products/:id/bom',
        'GET /api/chain/inventory-adjustments  (UC-30 review)',
        'POST /api/chain/inventory-adjustments/:id/review',
      ],
      warehouse: [
        'GET /api/warehouse/central-inventory|suppliers|stock-requests|outbounds/pending|purchase-orders|ingredients',
        'POST /api/warehouse/suppliers|purchase-orders[/:id/receive]|stock-requests/:id/resolve|outbounds/:id/ship',
        'PATCH /api/warehouse/ingredients/:id/thresholds',
      ],
      admin: [
        'GET|PATCH /api/admin/config',
        'GET|POST|PATCH /api/admin/branches',
        'POST /api/admin/branches/:id/force-close  (UC-11)',
        'GET|PATCH /api/admin/users',
        'GET /api/admin/audit',
        'GET /api/admin/alerts/low-stock  (UC-39)',
        'POST /api/admin/alerts/:id/ack',
      ],
      webhooks: ['POST /api/webhooks/payment', 'POST /api/webhooks/shipment (UC-43 hỗ trợ status=FAILED)'],
      system: ['POST /api/system/refresh-menus'],
    },
  });
});

module.exports = router;
