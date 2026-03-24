import React from 'react';
import { SafeAreaView, View, Text, StyleSheet, TouchableOpacity } from 'react-native';

export default function App() {
  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.card}>
        <Text style={styles.title}>Ubar Rider</Text>
        <Text style={styles.subtitle}>Live map + booking flow scaffold ready.</Text>

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
    marginBottom: 18
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
