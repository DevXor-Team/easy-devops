import { GoodDB, SQLiteDriver } from 'good.db';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Store the database in the user's home directory so it survives npm updates.
// Linux/macOS: ~/.config/easy-devops/
// Windows:     %APPDATA%\easy-devops\  (falls back to home dir if APPDATA unset)
const DATA_DIR = process.platform === 'win32'
  ? path.join(process.env.APPDATA || os.homedir(), 'easy-devops')
  : path.join(os.homedir(), '.config', 'easy-devops');

const DB_PATH = path.join(DATA_DIR, 'easy-devops.sqlite');

// ─── One-time migration from old package-relative location ───────────────────
const OLD_DATA_DIR = path.join(__dirname, '..', '..', 'data');
const OLD_DB_PATH = path.join(OLD_DATA_DIR, 'easy-devops.sqlite');
function migrateIfNeeded() {
  try {
    if (fs.existsSync(OLD_DB_PATH) && !fs.existsSync(DB_PATH)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.copyFileSync(OLD_DB_PATH, DB_PATH);
      // Rename old file so migration doesn't run again
      fs.renameSync(OLD_DB_PATH, OLD_DB_PATH + '.migrated');
    }
  } catch { /* non-fatal — new install will start fresh */ }
}
migrateIfNeeded();

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (err) {
  process.stderr.write(`[ERROR] Failed to create database directory: ${DATA_DIR}\n`);
  process.stderr.write(`Hint: Check that the current user has write access to: ${path.dirname(DATA_DIR)}\n`);
  process.exit(1);
}

let db;

function createDbConnection() {
  return new GoodDB(new SQLiteDriver({ path: DB_PATH }), {
    nested: "..",
    nestedIsEnabled: true,
    cache: {
      capacity: 1024,
      isEnabled: true,
    }
  });
}

try {
  db = createDbConnection();
} catch (err) {
  process.stderr.write(`[ERROR] Failed to initialize database at: ${DB_PATH}\n`);
  process.stderr.write(`Hint: Check that the current user has write access to: ${DATA_DIR}\n`);
  process.exit(1);
}

export { db };
export const dbGet = (key) => db.get(key);
export const dbSet = (key, value) => db.set(key, value);
export const dbDelete = (key) => db.delete(key);

/**
 * Closes the underlying SQLite connection.
 * Call this before any operation that needs to rename or replace the db file
 * (e.g. npm install -g), otherwise the open file handle causes EBUSY on Windows.
 */
export function closeDb() {
  try {
    db.driver?.db?.close?.();
  } catch { /* ignore */ }
}

/**
 * Reinitializes the database connection after it was closed.
 * Call this after closeDb() when you need to use the database again.
 */
export function initDb() {
  try {
    // Check if connection is still open
    db.driver?.db?.prepare('SELECT 1');
  } catch {
    // Connection is closed, create a new one
    db = createDbConnection();
  }
}
