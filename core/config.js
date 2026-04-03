import os from 'os';
import { dbGet, dbSet } from './db.js';

const platform = os.platform();

const DEFAULTS = {
  linux: {
    nginxDir: '/etc/nginx',
    sslDir: '/etc/easy-devops/ssl',
    dashboardPort: 6443,
    dashboardPassword: '',
    acmeEmail: '',
    os: 'linux',
  },
  win32: {
    nginxDir: 'C:\\nginx',
    sslDir: 'C:\\ssl',
    dashboardPort: 6443,
    dashboardPassword: '',
    acmeEmail: '',
    os: 'win32',
  },
};

const defaultConfig = DEFAULTS[platform] ?? DEFAULTS.linux;

export function loadConfig() {
  const stored = dbGet('config');
  if (stored) {
    // Merge with defaults to ensure new fields have default values
    return { ...defaultConfig, ...stored };
  }
  const config = { ...defaultConfig };
  saveConfig(config);
  return config;
}

export function saveConfig(config) {
  dbSet('config', config);
}
