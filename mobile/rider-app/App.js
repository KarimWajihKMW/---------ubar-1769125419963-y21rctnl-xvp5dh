import React, { useEffect, useMemo, useState } from 'react';
import { SafeAreaView, View, Text, StyleSheet, TouchableOpacity } from 'react-native';

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL || 'http://localhost:8080';

export default function App() {
  const [gatewayStatus, setGatewayStatus] = useState('checking');
  const [farePreview, setFarePreview] = useState(null);

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

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.card}>
        <Text style={styles.title}>Ubar Rider</Text>
        <Text style={styles.subtitle}>Live map + booking flow scaffold ready.</Text>
        <Text style={styles.meta}>Gateway: {gatewayStatus}</Text>
        <Text style={styles.meta}>Fare preview: {farePreview ? `${farePreview} SAR` : 'unavailable'}</Text>

        <TouchableOpacity style={styles.buttonPrimary}>
          <Text style={styles.buttonText}>Book Ride</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.buttonSecondary}>
          <Text style={styles.buttonTextSecondary}>Scheduled Rides</Text>
        </TouchableOpacity>
      </View>
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
  }
});
