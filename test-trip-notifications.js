// End-to-end realtime notification test for required trip lifecycle events.
// Usage: node test-trip-notifications.js

const { io } = require('socket.io-client');
const pool = require('./db');
const { hashPassword } = require('./auth');

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000/api';
const SOCKET_URL = process.env.SOCKET_URL || 'http://localhost:3000';

async function login(role, prefix) {
    const email = `${prefix}_${Date.now()}@ubar.sa`;
    const password = 'rt_notify_12345678';
    const phone = `9${Date.now().toString().slice(-9)}`;

    if (role !== 'passenger') {
        const hashed = await hashPassword(password);
        await pool.query(
            `INSERT INTO users (phone, name, email, password, role)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (email) DO UPDATE
             SET phone = EXCLUDED.phone,
                 name = EXCLUDED.name,
                 password = EXCLUDED.password,
                 role = EXCLUDED.role,
                 updated_at = CURRENT_TIMESTAMP`,
            [phone, `${role} user`, email, hashed, role]
        );

        if (role === 'driver') {
            await pool.query(
                `INSERT INTO drivers (name, phone, email, password, car_type, approval_status, status)
                 VALUES ($1, $2, $3, $4, 'economy', 'approved', 'online')
                 ON CONFLICT (email) DO UPDATE
                 SET name = EXCLUDED.name,
                     phone = EXCLUDED.phone,
                     password = EXCLUDED.password,
                     car_type = COALESCE(drivers.car_type, EXCLUDED.car_type),
                     approval_status = 'approved',
                     status = 'online',
                     updated_at = CURRENT_TIMESTAMP`,
                [`${role} user`, phone, email, hashed]
            );
        }
    }

    const res = await fetch(`${API_BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            email,
            password,
            role,
            name: `${role} user`,
            phone
        })
    });
    const data = await res.json();
    if (!res.ok || !data.success || !data.token || !data.data?.id) {
        throw new Error(`login_failed_${role}: ${data.error || res.status}`);
    }
    return { token: data.token, user: data.data };
}

async function api(endpoint, token, options = {}) {
    const res = await fetch(`${API_BASE_URL}${endpoint}`, {
        method: options.method || 'GET',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            ...(options.headers || {})
        },
        body: options.body ? JSON.stringify(options.body) : undefined
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
        throw new Error(`${endpoint}: ${data.error || res.status}`);
    }
    return data;
}

function waitForTripNotification(socket, tripId, type, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error(`timeout_trip_notification_${type}`));
        }, timeoutMs);

        const handler = (payload) => {
            if (String(payload?.trip_id) === String(tripId) && String(payload?.type) === String(type)) {
                cleanup();
                resolve(payload);
            }
        };

        const cleanup = () => {
            clearTimeout(timeout);
            socket.off('trip_notification', handler);
        };

        socket.on('trip_notification', handler);
    });
}

async function main() {
    console.log('🧪 Trip notifications realtime test');

    const passenger = await login('passenger', 'notif_passenger');
    const admin = await login('admin', 'notif_admin');

    const tripId = `TR-NOTIFY-${Date.now()}`;
    const created = await api('/trips', passenger.token, {
        method: 'POST',
        body: {
            id: tripId,
            user_id: passenger.user.id,
            pickup_location: 'Pickup A',
            dropoff_location: 'Dropoff B',
            pickup_lat: 24.7136,
            pickup_lng: 46.6753,
            pickup_accuracy: 4.1,
            pickup_timestamp: Date.now(),
            dropoff_lat: 24.6917,
            dropoff_lng: 46.6853,
            car_type: 'economy',
            cost: 22.75,
            distance: 5.5,
            duration: 12,
            payment_method: 'cash',
            source: 'passenger_app'
        }
    });

    if (!created?.data?.id) throw new Error('trip_create_failed');

    const drivers = await api('/drivers?limit=1', admin.token);
    const driver = Array.isArray(drivers?.data) && drivers.data.length ? drivers.data[0] : null;
    if (!driver?.id) throw new Error('no_driver_available_for_assign');

    const socket = io(SOCKET_URL, { transports: ['websocket', 'polling'], timeout: 10000 });
    await new Promise((resolve, reject) => {
        socket.on('connect', resolve);
        socket.on('connect_error', reject);
    });

    socket.emit('subscribe_trip', { trip_id: tripId });

    const acceptedP = waitForTripNotification(socket, tripId, 'driver_accepted_trip');
    await api(`/trips/${encodeURIComponent(tripId)}/assign`, admin.token, {
        method: 'PATCH',
        body: {
            driver_id: driver.id,
            driver_name: driver.name || 'Driver'
        }
    });
    await acceptedP;
    console.log('✅ notification: driver_accepted_trip');

    const arrivedP = waitForTripNotification(socket, tripId, 'driver_arrived');
    await api(`/trips/${encodeURIComponent(tripId)}/waiting/arrive`, admin.token, {
        method: 'POST',
        body: { lat: 24.71361, lng: 46.67531 }
    });
    await arrivedP;
    console.log('✅ notification: driver_arrived');

    const startedP = waitForTripNotification(socket, tripId, 'trip_started');
    await api(`/trips/${encodeURIComponent(tripId)}/status`, admin.token, {
        method: 'PATCH',
        body: { status: 'ongoing', trip_status: 'started' }
    });
    await startedP;
    console.log('✅ notification: trip_started');

    const endedP = waitForTripNotification(socket, tripId, 'trip_ended');
    await api(`/trips/${encodeURIComponent(tripId)}/status`, admin.token, {
        method: 'PATCH',
        body: {
            status: 'completed',
            trip_status: 'completed',
            cost: 22.75,
            distance: 5.5,
            duration: 12,
            payment_method: 'cash'
        }
    });
    await endedP;
    console.log('✅ notification: trip_ended');

    const ratedP = waitForTripNotification(socket, tripId, 'new_rating_received');
    await api('/rate-driver', passenger.token, {
        method: 'POST',
        body: {
            trip_id: tripId,
            rating: 5,
            comment: 'great trip'
        }
    });
    await ratedP;
    console.log('✅ notification: new_rating_received');

    socket.disconnect();
    console.log('🎉 Trip notifications realtime test passed');
}

main().catch((err) => {
    console.error('❌ Trip notifications realtime test failed:', err.message);
    process.exitCode = 1;
});
