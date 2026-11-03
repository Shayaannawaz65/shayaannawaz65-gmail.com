import { fileURLToPath } from 'node:url';
import express from 'express';
import apiRouteHandler from './api/[...route].mjs';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb', strict: true }));
const publicDir = fileURLToPath(new URL('./public/', import.meta.url));
app.get('/', (_req, res) => {
  res.sendFile(fileURLToPath(new URL('./public/index.html', import.meta.url)));
});
app.use(express.static(publicDir));

// One registry handles API dispatch in local Express and Vercel Functions.
app.all('/api/*splat', apiRouteHandler);

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
