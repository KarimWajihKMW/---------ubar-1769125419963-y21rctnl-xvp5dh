import React from 'react';
import { SafeAreaView, View, Text, StyleSheet, TouchableOpacity } from 'react-native';

export default function App() {
  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.card}>
        <Text style={styles.title}>Ubar Captain</Text>
        <Text style={styles.subtitle}>Requests, earnings, and trip lifecycle scaffold ready.</Text>

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
    marginBottom: 18
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
