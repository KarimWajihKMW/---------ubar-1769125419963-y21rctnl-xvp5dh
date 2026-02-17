#!/usr/bin/env node

const { spawn } = require('node:child_process');

const DEFAULT_API_BASE_URL = 'http://localhost:3000/api';
const baseURL = process.env.API_BASE_URL || DEFAULT_API_BASE_URL;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForHealth({ tries, delayMs }) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetchJson(`${baseURL}/health`, 1000);
      if (r.ok) return true;
    } catch {
      // ignore
    }
    await sleep(delayMs);
  }
  return false;
}

function runNodeScript(scriptPath, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      stdio: 'inherit',
      env: { ...process.env, API_BASE_URL: baseURL, ...extraEnv }
    });

    child.on('exit', (code, signal) => {
      if (signal) return resolve({ code: 1, signal });
      resolve({ code: code ?? 1 });
    });
  });
}

async function main() {
  let serverProcess = null;
  let startedServer = false;

  const alreadyHealthy = await waitForHealth({ tries: 2, delayMs: 250 });
  if (!alreadyHealthy) {
    console.log(`ℹ️ API not reachable at ${baseURL}. Starting server...`);

    serverProcess = spawn(process.execPath, ['server.js'], {
      stdio: 'inherit',
      env: { ...process.env }
    });
    startedServer = true;

    const healthy = await waitForHealth({ tries: 60, delayMs: 250 });
    if (!healthy) {
      console.error(`\n❌ Server did not become healthy at ${baseURL}/health`);
      if (serverProcess) serverProcess.kill('SIGTERM');
      process.exit(1);
    }
  } else {
    console.log(`ℹ️ Using already-running server at ${baseURL}`);
  }

  const api = await runNodeScript('test-api.js');
  if (api.code !== 0) {
    if (startedServer && serverProcess) serverProcess.kill('SIGTERM');
    process.exit(api.code);
  }

  const passenger = await runNodeScript('test-passenger-features.js');
  if (startedServer && serverProcess) serverProcess.kill('SIGTERM');

  process.exit(passenger.code);
}

process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

main().catch((err) => {
  console.error('❌ test-runner failed:', err);
  process.exit(1);
});
