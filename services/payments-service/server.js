const express = require('express');

const app = express();
const PORT = Number(process.env.PAYMENTS_SERVICE_PORT || 4102);

app.use(express.json());

app.get('/api/payments-service/health', (_req, res) => {
    return res.json({ success: true, service: 'payments-service', status: 'ok' });
});

app.post('/api/payments-service/fare/calculate', (req, res) => {
    const distanceKm = Math.max(0, Number(req.body.distance_km || 0));
    const durationMin = Math.max(0, Number(req.body.duration_min || 0));
    const surge = Math.max(1, Number(req.body.surge_multiplier || 1));

    const baseFare = 6;
    const perKm = 2.3;
    const perMin = 0.4;

    const subtotal = baseFare + (distanceKm * perKm) + (durationMin * perMin);
    const total = Number((subtotal * surge).toFixed(2));

    return res.json({
        success: true,
        data: {
            currency: 'SAR',
            base_fare: baseFare,
            distance_km: distanceKm,
            duration_min: durationMin,
            surge_multiplier: surge,
            total
        }
    });
});

app.post('/api/payments-service/commission/calculate', (req, res) => {
    const tripTotal = Math.max(0, Number(req.body.trip_total || 0));
    const commissionRate = Math.max(0, Math.min(100, Number(req.body.commission_rate || 20)));

    const commission = Number(((tripTotal * commissionRate) / 100).toFixed(2));
    const driverNet = Number((tripTotal - commission).toFixed(2));

    return res.json({
        success: true,
        data: {
            trip_total: tripTotal,
            commission_rate: commissionRate,
            commission,
            driver_net: driverNet
        }
    });
});

app.listen(PORT, () => {
    console.log(`💳 Payments service listening on ${PORT}`);
});
