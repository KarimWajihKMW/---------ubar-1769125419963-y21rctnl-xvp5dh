// Automated test for realtime trip sync via Socket.io
// Usage: node test-realtime-trip-sync.js

const { io } = require('socket.io-client');

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000/api';
const SOCKET_URL = process.env.SOCKET_URL || 'http://localhost:3000';

async function loginPassenger() {
    const email = `rt_passenger_${Date.now()}@ubar.sa`;
    const password = 'rt_test_12345678';

    const res = await fetch(`${API_BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            email,
            password,
            role: 'passenger',
            name: 'Realtime Passenger',
            phone: `9${Date.now().toString().slice(-9)}`
        })
    });
    const data = await res.json();
    if (!res.ok || !data.success || !data.token || !data.data?.id) {
        throw new Error(data.error || `Login failed ${res.status}`);
    }
    return { token: data.token, user: data.data };
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function waitForEvent(socket, eventName, predicate, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`Timeout waiting for event: ${eventName}`));
        }, timeoutMs);

        const handler = (payload) => {
            try {
                if (!predicate || predicate(payload)) {
                    cleanup();
                    resolve(payload);
                }
            } catch (e) {
                cleanup();
                reject(e);
            }
        };

        const cleanup = () => {
            clearTimeout(timer);
            socket.off(eventName, handler);
        };

        socket.on(eventName, handler);
    });
}

async function api(endpoint, options = {}) {
    const res = await fetch(`${API_BASE_URL}${endpoint}`, {
        headers: {
            'Content-Type': 'application/json',
            ...(options.headers || {})
        },
        ...options
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
        throw new Error(data.error || `API error ${res.status}`);
    }
    return data;
}

async function main() {
    console.log('🧪 Realtime Trip Sync Test (Socket.io)');

    const session = await loginPassenger();
    const authHeaders = { Authorization: `Bearer ${session.token}` };
    console.log('✅ Passenger login ok:', session.user.id);

    // Create trip
    const tripId = `TR-RT-${Date.now()}`;
    const created = await api('/trips', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
            id: tripId,
            user_id: session.user.id,
            pickup_location: 'Realtime Pickup',
            dropoff_location: 'Realtime Dropoff',
            pickup_lat: 24.7136,
            pickup_lng: 46.6753,
            pickup_accuracy: 5.0,
            pickup_timestamp: Date.now(),
            dropoff_lat: 24.6917,
            dropoff_lng: 46.6853,
            car_type: 'economy',
            cost: 12.5,
            distance: 3.2,
            duration: 8,
            payment_method: 'cash',
            source: 'passenger_app'
        })
    });

    if (!created?.data?.id) throw new Error('Trip not created');
    console.log('✅ Created trip:', created.data.id);

    // Connect socket
    const socket = io(SOCKET_URL, {
        transports: ['websocket', 'polling'],
        timeout: 10000
    });

    await new Promise((resolve, reject) => {
        socket.on('connect', resolve);
        socket.on('connect_error', reject);
    });

    console.log('✅ Socket connected:', socket.id);

    // Subscribe
    socket.emit('subscribe_trip', { trip_id: tripId });

    // Pickup live update -> expect trip_pickup_live_update
    const pickupLivePromise = waitForEvent(
        socket,
        'trip_pickup_live_update',
        (p) => String(p?.trip_id) === String(tripId) && Number.isFinite(Number(p?.pickup_lat)) && Number.isFinite(Number(p?.pickup_lng)),
        5000
    );

    await api(`/trips/${encodeURIComponent(tripId)}/pickup`, {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({
            pickup_lat: 24.71361,
            pickup_lng: 46.67531,
            pickup_accuracy: 6.2,
            pickup_timestamp: Date.now(),
            source: 'test-realtime-trip-sync'
        })
    });

    const pickupLive = await pickupLivePromise;
    console.log('✅ trip_pickup_live_update received:', {
        trip_id: pickupLive.trip_id,
        pickup_lat: pickupLive.pickup_lat,
        pickup_lng: pickupLive.pickup_lng
    });

    // Start trip -> expect trip_started
    const tripStartedPromise = waitForEvent(
        socket,
        'trip_started',
        (p) => String(p?.trip_id) === String(tripId) && p?.trip_status === 'started',
        5000
    );

    const tripStartedNotificationPromise = waitForEvent(
        socket,
        'trip_notification',
        (p) => String(p?.trip_id) === String(tripId) && String(p?.type || '') === 'trip_started',
        5000
    );

    await api(`/trips/${encodeURIComponent(tripId)}/status`, {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({ status: 'ongoing', trip_status: 'started' })
    });

    const tripStarted = await tripStartedPromise;
    const tripStartedNotification = await tripStartedNotificationPromise;
    console.log('✅ trip_started received:', tripStarted);
    console.log('✅ trip_notification(trip_started) received:', {
        trip_id: tripStartedNotification.trip_id,
        type: tripStartedNotification.type
    });

    // Driver location update -> expect driver_live_location
    const locPromise = waitForEvent(
        socket,
        'driver_live_location',
        (p) => String(p?.trip_id) === String(tripId) && Number.isFinite(Number(p?.driver_lat)) && Number.isFinite(Number(p?.driver_lng)),
        5000
    );

    socket.emit('driver_location_update', {
        trip_id: tripId,
        driver_lat: 24.71361,
        driver_lng: 46.67531,
        timestamp: Date.now()
    });

    const loc = await locPromise;
    console.log('✅ driver_live_location received:', { trip_id: loc.trip_id, driver_lat: loc.driver_lat, driver_lng: loc.driver_lng });

    // Complete trip -> expect trip_completed
    const tripCompletedPromise = waitForEvent(
        socket,
        'trip_completed',
        (p) => String(p?.trip_id) === String(tripId) && p?.trip_status === 'completed',
        5000
    );

    const tripCompletedNotificationPromise = waitForEvent(
        socket,
        'trip_notification',
        (p) => String(p?.trip_id) === String(tripId) && String(p?.type || '') === 'trip_ended',
        5000
    );

    await api(`/trips/${encodeURIComponent(tripId)}/status`, {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({ status: 'completed', trip_status: 'completed', cost: 12.5, distance: 3.2, duration: 8 })
    });

    const tripCompleted = await tripCompletedPromise;
    const tripCompletedNotification = await tripCompletedNotificationPromise;
    console.log('✅ trip_completed received:', tripCompleted);
    console.log('✅ trip_notification(trip_ended) received:', {
        trip_id: tripCompletedNotification.trip_id,
        type: tripCompletedNotification.type
    });

    // Rate -> expect trip_rated
    const tripRatedPromise = waitForEvent(
        socket,
        'trip_rated',
        (p) => String(p?.trip_id) === String(tripId) && p?.trip_status === 'rated',
        5000
    );

    const tripRatedNotificationPromise = waitForEvent(
        socket,
        'trip_notification',
        (p) => String(p?.trip_id) === String(tripId) && String(p?.type || '') === 'new_rating_received',
        5000
    );

    await api(`/trips/${encodeURIComponent(tripId)}/status`, {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({ status: 'completed', trip_status: 'rated', passenger_rating: 5 })
    });

    const tripRated = await tripRatedPromise;
    const tripRatedNotification = await tripRatedNotificationPromise;
    console.log('✅ trip_rated received:', tripRated);
    console.log('✅ trip_notification(new_rating_received) received:', {
        trip_id: tripRatedNotification.trip_id,
        type: tripRatedNotification.type
    });

    socket.disconnect();

    console.log('🎉 Realtime trip sync test passed!');
}

main().catch((err) => {
    console.error('❌ Realtime trip sync test failed:', err.message);
    process.exitCode = 1;
});
