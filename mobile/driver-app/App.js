import React, { useEffect, useState } from 'react';
import { SafeAreaView, View, Text, StyleSheet, TouchableOpacity } from 'react-native';

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL || 'http://localhost:8080';

export default function App() {
  const [gatewayStatus, setGatewayStatus] = useState('checking');
  const [assignmentHint, setAssignmentHint] = useState('loading');

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

    async function loadAssignmentHint() {
      try {
        const res = await fetch(`${API_BASE_URL}/api/ms/trips/match/recommendation?demand=0.82&supply=0.55`, {
          headers: {
            'x-tenant-id': 'demo-tenant'
          }
        });
        const data = await res.json();
        if (!mounted) return;
        setAssignmentHint(data?.data?.strategy || 'unavailable');
      } catch (_) {
        if (!mounted) return;
        setAssignmentHint('unavailable');
      }
    }

    loadGatewayStatus();
    loadAssignmentHint();

    return () => {
      mounted = false;
    };
  }, []);

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.card}>
        <Text style={styles.title}>Ubar Captain</Text>
        <Text style={styles.subtitle}>Requests, earnings, and trip lifecycle scaffold ready.</Text>
        <Text style={styles.meta}>Gateway: {gatewayStatus}</Text>
        <Text style={styles.meta}>Dispatch strategy: {assignmentHint}</Text>

        <TouchableOpacity style={styles.buttonPrimary}>
          <Text style={styles.buttonText}>Go Online</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.buttonSecondary}>
          <Text style={styles.buttonTextSecondary}>View Earnings</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#081018',
    justifyContent: 'center',
    padding: 20
  },
  card: {
    backgroundColor: '#0f1e2e',
    borderRadius: 16,
    padding: 18,
    borderWidth: 1,
    borderColor: '#1d3850'
  },
  title: {
    color: '#f4fbff',
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 8
  },
  subtitle: {
    color: '#c8d7e6',
    fontSize: 15,
    marginBottom: 10
  },
  meta: {
    color: '#a5c6df',
    fontSize: 13,
    marginBottom: 6
  },
  buttonPrimary: {
    backgroundColor: '#22c55e',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 10
  },
  buttonSecondary: {
    borderWidth: 1,
    borderColor: '#22c55e',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center'
  },
  buttonText: {
    color: '#06230f',
    fontWeight: '700'
  },
  buttonTextSecondary: {
    color: '#22c55e',
    fontWeight: '700'
  }
});
