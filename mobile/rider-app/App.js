import React, { useEffect, useMemo, useRef, useState } from 'react';
import { SafeAreaView, View, Text, StyleSheet, TouchableOpacity, Pressable } from 'react-native';
import { io } from 'socket.io-client';

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL || 'http://localhost:8080';
const SOCKET_URL = process.env.EXPO_PUBLIC_SOCKET_URL || API_BASE_URL.replace(/\/api$/, '');
const AUTH_TOKEN = process.env.EXPO_PUBLIC_AUTH_TOKEN || '';
const DEFAULT_TRIP_ID = process.env.EXPO_PUBLIC_TRIP_ID || '';

export default function App() {
  const [gatewayStatus, setGatewayStatus] = useState('checking');
  const [farePreview, setFarePreview] = useState(null);
  const [currentScreen, setCurrentScreen] = useState('home');
  const [currentTripId, setCurrentTripId] = useState(DEFAULT_TRIP_ID);
  const [activeNotification, setActiveNotification] = useState(null);
  const [socketStatus, setSocketStatus] = useState('disconnected');
  const socketRef = useRef(null);

  const farePayload = useMemo(() => ({
    distance_km: 8,
    duration_min: 18,
    surge_multiplier: 1.2
  }), []);

  useEffect(() => {
    let mounted = true;

    async function loadGatewayStatus() {
      try {
        const res = await fetch(`${API_BASE_URL}/health`);
        const data = await res.json();
        if (!mounted) return;
        setGatewayStatus(data?.status === 'ok' ? 'online' : 'degraded');
      } catch (_) {
        if (!mounted) return;
        setGatewayStatus('offline');
      }
    }

    async function loadFarePreview() {
      try {
        const res = await fetch(`${API_BASE_URL}/api/ms/payments/fare/calculate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-tenant-id': 'demo-tenant'
          },
          body: JSON.stringify(farePayload)
        });
        const data = await res.json();
        if (!mounted) return;
        setFarePreview(data?.data?.total || null);
      } catch (_) {
        if (!mounted) return;
        setFarePreview(null);
      }
    }

    loadGatewayStatus();
    loadFarePreview();

    return () => {
      mounted = false;
    };
  }, [farePayload]);

  useEffect(() => {
    const socket = io(SOCKET_URL, {
      transports: ['websocket', 'polling'],
      timeout: 10000
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setSocketStatus('connected');
      if (AUTH_TOKEN) {
        socket.emit('subscribe_user', { token: AUTH_TOKEN });
      }
      if (currentTripId) {
        socket.emit('subscribe_trip', { trip_id: currentTripId });
      }
    });

    socket.on('disconnect', () => {
      setSocketStatus('disconnected');
    });

    socket.on('trip_notification', (payload) => {
      setActiveNotification(payload || null);
    });

    socket.on('trip_started', (payload) => {
      setActiveNotification({
        type: 'trip_started',
        title: 'Trip started',
        message: 'Your trip is now in progress.',
        trip_id: payload?.trip_id || currentTripId,
        target_screen: 'live-trip'
      });
    });

    socket.on('trip_completed', (payload) => {
      setActiveNotification({
        type: 'trip_ended',
        title: 'Trip ended',
        message: 'Trip completed successfully.',
        trip_id: payload?.trip_id || currentTripId,
        target_screen: 'trip-summary'
      });
    });

    socket.on('driver_arrived', (payload) => {
      setActiveNotification({
        type: 'driver_arrived',
        title: 'Driver arrived',
        message: 'Your captain has arrived at pickup point.',
        trip_id: payload?.trip_id || currentTripId,
        target_screen: 'pickup'
      });
    });

    socket.on('trip_rated', (payload) => {
      setActiveNotification({
        type: 'new_rating_received',
        title: 'Rating received',
        message: 'Your trip has a new rating.',
        trip_id: payload?.trip_id || currentTripId,
        target_screen: 'trip-rating'
      });
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [currentTripId]);

  function onTapNotification() {
    if (!activeNotification) return;
    if (activeNotification.trip_id) {
      setCurrentTripId(String(activeNotification.trip_id));
    }
    setCurrentScreen(activeNotification.target_screen || 'trip-details');
    setActiveNotification(null);
  }

  function dismissNotification() {
    setActiveNotification(null);
  }

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.card}>
        <Text style={styles.title}>Ubar Rider</Text>
        <Text style={styles.subtitle}>Live map + booking flow scaffold ready.</Text>
        <Text style={styles.meta}>Gateway: {gatewayStatus}</Text>
        <Text style={styles.meta}>Realtime: {socketStatus}</Text>
        <Text style={styles.meta}>Screen: {currentScreen}</Text>
        <Text style={styles.meta}>Trip: {currentTripId || 'not selected'}</Text>
        <Text style={styles.meta}>Fare preview: {farePreview ? `${farePreview} SAR` : 'unavailable'}</Text>

        <TouchableOpacity style={styles.buttonPrimary}>
          <Text style={styles.buttonText}>Book Ride</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.buttonSecondary}>
          <Text style={styles.buttonTextSecondary}>Scheduled Rides</Text>
        </TouchableOpacity>
      </View>

      {activeNotification ? (
        <Pressable style={styles.notificationWrap} onPress={onTapNotification}>
          <View style={styles.notificationCard}>
            <Text style={styles.notificationTitle}>{activeNotification.title || 'Trip update'}</Text>
            <Text style={styles.notificationMessage}>{activeNotification.message || 'Open to view details'}</Text>
            <Text style={styles.notificationMeta}>Trip ID: {activeNotification.trip_id || currentTripId || 'N/A'}</Text>
            <TouchableOpacity onPress={dismissNotification} style={styles.dismissButton}>
              <Text style={styles.dismissText}>Dismiss</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0b1220',
    justifyContent: 'center',
    padding: 20
  },
  card: {
    backgroundColor: '#111a2c',
    borderRadius: 16,
    padding: 18,
    borderWidth: 1,
    borderColor: '#253251'
  },
  title: {
    color: '#f5f7ff',
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 8
  },
  subtitle: {
    color: '#cdd5ea',
    fontSize: 15,
    marginBottom: 10
  },
  meta: {
    color: '#9fb1d9',
    fontSize: 13,
    marginBottom: 6
  },
  buttonPrimary: {
    backgroundColor: '#f59e0b',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 10
  },
  buttonSecondary: {
    borderWidth: 1,
    borderColor: '#f59e0b',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center'
  },
  buttonText: {
    color: '#111827',
    fontWeight: '700'
  },
  buttonTextSecondary: {
    color: '#f59e0b',
    fontWeight: '700'
  },
  notificationWrap: {
    position: 'absolute',
    left: 12,
    right: 12,
    top: 12
  },
  notificationCard: {
    backgroundColor: '#1f2937',
    borderWidth: 1,
    borderColor: '#f59e0b',
    borderRadius: 14,
    padding: 12
  },
  notificationTitle: {
    color: '#fde68a',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 4
  },
  notificationMessage: {
    color: '#f3f4f6',
    fontSize: 13,
    marginBottom: 6
  },
  notificationMeta: {
    color: '#9ca3af',
    fontSize: 12,
    marginBottom: 8
  },
  dismissButton: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: '#4b5563',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6
  },
  dismissText: {
    color: '#e5e7eb',
    fontSize: 12,
    fontWeight: '600'
  }
});
