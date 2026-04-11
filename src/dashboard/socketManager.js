import http from 'http';
import { spawn } from 'child_process';
import path from 'path';
import { Server as SocketIO } from 'socket.io';

import { getStatus } from './lib/nginx-service.js';
import { listAllCerts } from './lib/cert-reader.js';
import { loadConfig } from '../core/config.js';
import { dbGet } from '../core/db.js';
import {
  createNginxDownEvent,
  createNginxRecoveredEvent,
  createDomainDownEvent,
  createDomainRecoveredEvent,
} from '../core/events.js';
import { sendNotification } from '../core/notifier.js';
import {
  getEffectiveChannelIds,
  getAllDomainChannelIds,
  shouldSendNotification,
} from '../core/domainNotifier.js';

let connectedClients = 0;
const activeTails = new Map();

/**
 * Emit nginx status and handle notification state transitions.
 * Uses state tracking to prevent spam and support recovery notifications.
 */
async function emitNginxStatus(target) {
  try {
    const status = await getStatus();
    target.emit('nginx:status', status);

    const currentStatus = status.running ? 'up' : 'down';
    const decision = shouldSendNotification(null, 'nginx_down', currentStatus);

    if (decision.shouldNotify) {
      let event;
      if (decision.reason === 'recovery') {
        event = createNginxRecoveredEvent();
      } else {
        event = createNginxDownEvent();
      }

      console.log(`[socketManager] Sending nginx notification: ${decision.reason}`);
      target.emit('notification:new', event);

      // External channel routing (fire-and-forget, isolated)
      try {
        const channels = getAllDomainChannelIds('nginx_down');
        await sendNotification(event, channels);
      } catch (err) {
        console.error('[socketManager] sendNotification failed:', err.message);
      }
    }
  } catch (err) {
    target.emit('nginx:status', { running: false, version: null, pid: null, error: err.message });
  }
}

/**
 * Emit cert expiry notifications.
 * Note: Cert expiry doesn't use state tracking because it's a time-based event,
 * not a state transition. We notify whenever a cert is expiring, regardless of
 * whether we notified before.
 */
async function emitCertNotifications(target) {
  try {
    const certs = await listAllCerts();
    for (const cert of certs) {
      if (cert.daysLeft !== null && cert.daysLeft < 30) {
        const event = {
          id: `cert-expiry-${cert.domain}-${Date.now()}`,
          type: 'cert_expiry',
          severity: cert.daysLeft < 10 ? 'danger' : 'warning',
          message: `🔒 SSL cert for ${cert.domain} expires in ${cert.daysLeft} day${cert.daysLeft === 1 ? '' : 's'}`,
          domain: cert.domain,
          timestamp: Date.now(),
        };
        target.emit('notification:new', event);

        // External channel routing (fire-and-forget, isolated)
        try {
          const channels = getEffectiveChannelIds(cert.domain, 'cert_expiry');
          await sendNotification(event, channels);
        } catch (err) {
          console.error('[socketManager] sendNotification failed:', err.message);
        }
      }
    }
  } catch {
    /* non-fatal */
  }
}

/**
 * Check if a domain backend is responding.
 */
function checkDomainHealth(host, port) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host,
        port: Number(port),
        path: '/',
        method: 'HEAD',
        timeout: 5000,
      },
      (res) => {
        resolve({ up: true, status: res.statusCode });
        res.resume();
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ up: false });
    });
    req.on('error', () => resolve({ up: false }));
    req.end();
  });
}

/**
 * Emit domain health status and handle notification state transitions.
 * Uses state tracking to:
 * 1. Prevent spam (don't re-notify if already down)
 * 2. Send recovery notifications when domain comes back up
 */
async function emitDomainHealth(target) {
  try {
    const domains = dbGet('domains') || [];
    const results = await Promise.all(
      domains.map(async (d) => {
        const host = d.backendHost || '127.0.0.1';
        const port = d.port || 80;

        // Skip external URL backends
        if (typeof host === 'string' && host.startsWith('http')) return { name: d.name, up: null };

        const { up } = await checkDomainHealth(host, port);
        return { name: d.name, up, port, host };
      })
    );

    target.emit('domain:health', results);

    // Process state transitions for each domain
    for (const result of results) {
      if (result.up === null) continue; // Skip external URL backends

      const currentStatus = result.up ? 'up' : 'down';
      const decision = shouldSendNotification(result.name, 'domain_health', currentStatus);

      if (decision.shouldNotify) {
        let event;
        if (decision.reason === 'recovery') {
          event = createDomainRecoveredEvent(result.name, result.port);
        } else {
          event = createDomainDownEvent(result.name, result.port);
        }

        console.log(`[socketManager] Sending domain health notification for ${result.name}: ${decision.reason}`);
        target.emit('notification:new', event);

        try {
          const channelIds = getEffectiveChannelIds(result.name, 'domain_health');
          await sendNotification(event, channelIds);
        } catch (err) {
          console.error('[socketManager] domain health sendNotification failed:', err.message);
        }
      }
    }
  } catch (err) {
    console.error('[socketManager] emitDomainHealth error:', err.message);
  }
}

/**
 * Get the path to a log file.
 */
function getLogPath(logFile) {
  const { nginxDir } = loadConfig();
  const file = logFile === 'access' ? 'access.log' : 'error.log';

  // Linux standard path first, fall back to nginxDir/logs/
  if (process.platform !== 'win32') {
    return `/var/log/nginx/${file}`;
  }
  return path.join(nginxDir, 'logs', file);
}

/**
 * Start tailing a log file for a socket.
 */
function startTail(socket, logFile) {
  // Kill any existing tail for this socket
  stopTail(socket.id);

  const logPath = getLogPath(logFile);
  const args = process.platform === 'win32'
    ? ['Get-Content', '-Path', logPath, '-Wait', '-Tail', '50']
    : ['-n', '50', '-f', logPath];
  const cmd = process.platform === 'win32' ? 'powershell' : 'tail';

  const child = spawn(cmd, args, {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });

  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop(); // keep incomplete line in buffer
    for (const line of lines) {
      if (line.trim()) socket.emit('logs:line', { line: line.trim(), logFile });
    }
  });

  child.on('error', () => {});
  child.on('close', () => {
    activeTails.delete(socket.id);
  });

  activeTails.set(socket.id, { process: child, logFile });
}

/**
 * Stop tailing a log file for a socket.
 */
function stopTail(socketId) {
  const entry = activeTails.get(socketId);
  if (entry) {
    try {
      entry.process.kill();
    } catch {}
    activeTails.delete(socketId);
  }
}

/**
 * Initialize the Socket.IO server.
 */
function initSocket(httpServer) {
  const io = new SocketIO(httpServer);

  io.on('connection', (socket) => {
    connectedClients++;

    emitNginxStatus(socket);
    emitCertNotifications(socket);

    socket.on('logs:subscribe', ({ logFile }) => startTail(socket, logFile || 'error'));
    socket.on('logs:unsubscribe', () => stopTail(socket.id));

    // Send initial domain health on connect
    emitDomainHealth(socket);

    socket.on('disconnect', () => {
      connectedClients--;
      stopTail(socket.id);
    });
  });

  // Poll domain health every 60 seconds
  setInterval(() => {
    if (connectedClients > 0) emitDomainHealth(io);
  }, 60_000);

  // Broadcast nginx status to all clients every 5 seconds
  setInterval(() => {
    if (connectedClients > 0) emitNginxStatus(io);
  }, 5000);

  // Check cert expiry every 12 hours
  setInterval(() => {
    if (connectedClients > 0) emitCertNotifications(io);
  }, 12 * 60 * 60 * 1000);
}

export { initSocket };
