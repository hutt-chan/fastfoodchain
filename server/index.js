const path = require('path');
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const pool = require('./db');
const { refreshBranchProductAvailability } = require('./services/inventoryService');
const { errorHandler } = require('./middleware/errorHandler');

const { startCronJobs } = require('./cronJobs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use('/api/webhooks', require('./routes/webhooks'));
app.use(express.json({ limit: '1mb' }));

app.use('/api/system', require('./routes/systemMeta'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api', require('./routes/customer'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/chain', require('./routes/chain'));
app.use('/api/warehouse', require('./routes/warehouse'));
app.use('/api/branch', require('./routes/branch'));
app.use('/api/kitchen', require('./routes/kitchen'));

/** UC-39/40: làm mới tắt món theo tồn kho (gọi định kỳ hoặc thủ công) */
app.post('/api/system/refresh-menus', async (req, res) => {
  const [branches] = await pool.execute('SELECT id FROM branches');
  for (const b of branches) {
    await refreshBranchProductAvailability(b.id);
  }
  res.json({ ok: true, branches: branches.length });
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(errorHandler);

startCronJobs();

app.listen(PORT, () => {
  console.log(`API + static http://localhost:${PORT}`);
});
