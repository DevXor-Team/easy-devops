import { createServer } from 'http';
import http from 'http';
import { createRequire } from 'module';
import { spawn } from 'child_process';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import session from 'express-session';
import { Server as SocketIO } from 'socket.io';
import { loadConfig } from '../core/config.js';
import { dbGet, dbSet } from '../core/db.js';
import authRouter from './routes/auth.js';
import domainsRouter from './routes/domains.js';
import sslRouter from './routes/ssl.js';
import nginxRouter from './routes/nginx.js';
import settingsRouter from './routes/settings.js';
import { getStatus } from './lib/nginx-service.js';
import { listAllCerts } from './lib/cert-reader.js';

const require = createRequire(import.meta.url);
const FileStore = require('session-file-store')(session);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// EJS view engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.json({ limit: '1mb' }));

// ─── Session secret — generated once, persisted in SQLite ────────────────────
let sessionSecret = dbGet('session_secret');
if (!sessionSecret) {
  sessionSecret = crypto.randomBytes(32).toString('hex');
  dbSet('session_secret', sessionSecret);
}

// Sessions stored on disk so they survive restarts
const SESSION_DIR = process.platform === 'win32'
  ? path.join(process.env.APPDATA || os.homedir(), 'easy-devops', 'sessions')
  : path.join(os.homedir(), '.config', 'easy-devops', 'sessions');

app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  store: new FileStore({ path: SESSION_DIR, retries: 1, logFn() {} }),
  cookie: { httpOnly: true },
}));

// Static files - disable index serving so EJS handles root
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.use('/api', authRouter);
app.use('/api/domains', domainsRouter);
app.use('/api/ssl', sslRouter);
app.use('/api/nginx', nginxRouter);
app.use('/api', settingsRouter);

// Render EJS template for all other routes
app.use((req, res) => res.render('index'));

// ─── HTTP server + Socket.io ──────────────────────────────────────────────────

const httpServer = createServer(app);
const io = new SocketIO(httpServer);

let connectedClients = 0;

async function emitNginxStatus(target) {
  try {
    const status = await getStatus();
    target.emit('nginx:status', status);
    // Emit notification if nginx is down
    if (!status.running) {
      target.emit('notification:new', {
        id: 'nginx-down',
        type: 'nginx_down',
        severity: 'danger',
        message: 'Nginx is not running',
        timestamp: Date.now(),
      });
    }
  } catch (err) {
    target.emit('nginx:status', { running: false, version: null, pid: null, error: err.message });
  }
}

// ─── Cert expiry notifications ────────────────────────────────────────────────
async function emitCertNotifications(target) {
  try {
    const certs = await listAllCerts();
    for (const cert of certs) {
      if (cert.daysLeft !== null && cert.daysLeft < 30) {
        const severity = cert.daysLeft < 10 ? 'danger' : 'warning';
        target.emit('notification:new', {
          id: `cert-expiry-${cert.domain}`,
          type: 'cert_expiry',
          severity,
          message: `SSL cert for ${cert.domain} expires in ${cert.daysLeft} day${cert.daysLeft === 1 ? '' : 's'}`,
          domain: cert.domain,
          timestamp: Date.now(),
        });
      }
    }
  } catch { /* non-fatal */ }
}

// ─── Domain health checks ─────────────────────────────────────────────────────
function checkDomainHealth(host, port) {
  return new Promise((resolve) => {
    const req = http.request({ host, port: Number(port), path: '/', method: 'HEAD', timeout: 5000 }, (res) => {
      resolve({ up: true, status: res.statusCode });
      res.resume();
    });
    req.on('timeout', () => { req.destroy(); resolve({ up: false }); });
    req.on('error', () => resolve({ up: false }));
    req.end();
  });
}

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
        return { name: d.name, up };
      })
    );
    target.emit('domain:health', results);
  } catch { /* non-fatal */ }
}

// ─── Live log streaming ───────────────────────────────────────────────────────
const activeTails = new Map(); // socketId → { process, logFile }

function getLogPath(logFile) {
  const { nginxDir } = loadConfig();
  const file = logFile === 'access' ? 'access.log' : 'error.log';
  // Linux standard path first, fall back to nginxDir/logs/
  if (process.platform !== 'win32') {
    return `/var/log/nginx/${file}`;
  }
  return path.join(nginxDir, 'logs', file);
}

function startTail(socket, logFile) {
  // Kill any existing tail for this socket
  stopTail(socket.id);

  const logPath = getLogPath(logFile);
  const args = process.platform === 'win32'
    ? ['Get-Content', '-Path', logPath, '-Wait', '-Tail', '50']
    : ['-n', '50', '-f', logPath];
  const cmd = process.platform === 'win32' ? 'powershell' : 'tail';

  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
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
  child.on('close', () => { activeTails.delete(socket.id); });
  activeTails.set(socket.id, { process: child, logFile });
}

function stopTail(socketId) {
  const entry = activeTails.get(socketId);
  if (entry) {
    try { entry.process.kill(); } catch {}
    activeTails.delete(socketId);
  }
}

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

// ─── Start ────────────────────────────────────────────────────────────────────

const { dashboardPort } = loadConfig();
const port = Number(process.env.DASHBOARD_PORT) || dashboardPort;
httpServer.listen(port, () => {
  process.stdout.write(`Dashboard running on port ${port}\n`);
});

export { app };
