const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = Number(process.env.GATEWAY_PORT || 8080);

const tripsTarget = process.env.TRIPS_SERVICE_URL || 'http://localhost:4101';
const paymentsTarget = process.env.PAYMENTS_SERVICE_URL || 'http://localhost:4102';
const monolithTarget = process.env.MONOLITH_URL || 'http://localhost:3000';

app.use(cors());
app.use(helmet({ contentSecurityPolicy: false }));

app.get('/health', (_req, res) => {
    res.json({
        success: true,
        service: 'api-gateway',
        status: 'ok',
        routes: {
            trips: '/api/ms/trips/*',
            payments: '/api/ms/payments/*',
            fallback: '/api/*'
        }
    });
});

app.use(createProxyMiddleware({
    target: tripsTarget,
    changeOrigin: true,
    pathFilter: '/api/ms/trips',
    pathRewrite: { '^/api/ms/trips': '/api/trips-service' },
    logLevel: 'warn'
}));

app.use(createProxyMiddleware({
    target: paymentsTarget,
    changeOrigin: true,
    pathFilter: '/api/ms/payments',
    pathRewrite: { '^/api/ms/payments': '/api/payments-service' },
    logLevel: 'warn'
}));

// Backward-compatible fallback to existing monolith API.
app.use('/api', createProxyMiddleware({
    target: monolithTarget,
    changeOrigin: true,
    logLevel: 'warn'
}));

app.listen(PORT, () => {
    console.log(`🌐 API Gateway listening on ${PORT}`);
    console.log(`➡️ Trips service: ${tripsTarget}`);
    console.log(`➡️ Payments service: ${paymentsTarget}`);
    console.log(`➡️ Monolith fallback: ${monolithTarget}`);
});
