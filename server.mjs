import { fileURLToPath } from 'node:url';
import express from 'express';
import tronSyncHandler from './api/tron/sync.mjs';
import heartbeatHandler from './api/console/heartbeat.mjs';
import consoleStatusHandler from "./api/console/status.mjs";
import transactionsHandler from './api/console/transactions.mjs';
import paymentOrdersHandler from './api/console/payment-orders.mjs';
import paymentStatusHandler from './api/console/payment-status.mjs';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb', strict: true }));
const publicDir = fileURLToPath(new URL('./public/', import.meta.url));
app.get('/', (_req, res) => {
  res.sendFile(fileURLToPath(new URL('./public/index.html', import.meta.url)));
});
app.use(express.static(publicDir));

app.post('/api/tron/sync', tronSyncHandler);
app.post('/api/console/heartbeat', heartbeatHandler);
app.post('/api/console/payment-orders', paymentOrdersHandler);
app.all('/api/console/payment-status', paymentStatusHandler);
app.get('/api/console/status', consoleStatusHandler);
app.get('/api/console/transactions', transactionsHandler);

app.get('/health', (_req, res) => {
  res.json({
    service: 'T2T TRON USDT TRC20 Console',
    network: 'TRON mainnet',
    asset: 'USDT TRC20',
    status: 'ready',
    blockchainSyncPerformed: false,
    message: 'Console health only. This endpoint does not initiate blockchain sync or confirm transfers.'
  });
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`T2T TRON USDT TRC20 Console listening on port ${PORT}`);
});
