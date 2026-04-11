/**
 * Per-domain notification config storage.
 * SQLite key: 'domain_notification_config'
 *
 * Config shape per domain:
 * { nginx_down: { enabled: bool, channelIds: [uuid, ...] }, ... }
 *
 * channelIds are UUIDs referencing entries in the notification_channels key.
 * Empty channelIds means dashboard-only (no external dispatch).
 *
 * Also tracks notification state to prevent spam and support recovery notifications.
 * SQLite key: 'notification_state'
 */

import { dbGet, dbSet } from './db.js';

const DB_KEY = 'domain_notification_config';
const STATE_DB_KEY = 'notification_state';
const KNOWN_EVENT_TYPES = ['nginx_down', 'cert_expiry', 'domain_health'];

/**
 * Default notification config returned for unconfigured domains.
 * All events enabled, no external channels (dashboard-only) — opt-in model.
 */
export const DOMAIN_NOTIF_DEFAULTS = {
  nginx_down: { enabled: true, channelIds: [] },
  cert_expiry: { enabled: true, channelIds: [] },
  domain_health: { enabled: true, channelIds: [] },
};

/**
 * Validates a domain notification config object.
 * @param {object} config
 * @throws {Error} with descriptive message on invalid input
 */
function validateDomainNotifConfig(config) {
  if (typeof config !== 'object' || config === null) {
    throw new Error('Config must be a non-null object');
  }

  for (const key of Object.keys(config)) {
    if (!KNOWN_EVENT_TYPES.includes(key)) {
      throw new Error(`Invalid event type: '${key}'. Known types: ${KNOWN_EVENT_TYPES.join(', ')}`);
    }

    const entry = config[key];
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`Entry for '${key}' must be an object`);
    }

    if (typeof entry.enabled !== 'boolean') {
      throw new Error(`Entry for '${key}' must have boolean 'enabled' field`);
    }

    if (!Array.isArray(entry.channelIds)) {
      throw new Error(`Entry for '${key}' must have array 'channelIds' field`);
    }

    for (const id of entry.channelIds) {
      if (typeof id !== 'string') {
        throw new Error(`channelIds in '${key}' must contain only strings`);
      }
    }
  }
}

/**
 * Returns the stored notification config for a domain, falling back to defaults.
 * @param {string} domain
 * @returns {object}
 */
export function getDomainNotifConfig(domain) {
  let map;
  try {
    map = dbGet(DB_KEY);
  } catch {
    return { ...DOMAIN_NOTIF_DEFAULTS };
  }

  if (!map || typeof map !== 'object') {
    return { ...DOMAIN_NOTIF_DEFAULTS };
  }

  return map[domain] ? { ...map[domain] } : { ...DOMAIN_NOTIF_DEFAULTS };
}

/**
 * Saves notification config for a domain.
 * @param {string} domain
 * @param {object} config
 * @throws {Error} if config is invalid
 */
export function saveDomainNotifConfig(domain, config) {
  validateDomainNotifConfig(config);

  let map = dbGet(DB_KEY);
  if (!map || typeof map !== 'object') {
    map = {};
  }

  map[domain] = config;
  dbSet(DB_KEY, map);
}

/**
 * Returns the channel IDs that should receive a given event for a domain.
 * Returns [] when the event is disabled or has no channels assigned.
 * @param {string|null} domain
 * @param {string} eventType
 * @returns {string[]}
 */
export function getEffectiveChannelIds(domain, eventType) {
  if (!KNOWN_EVENT_TYPES.includes(eventType)) {
    return [];
  }

  const config = getDomainNotifConfig(domain);
  const entry = config[eventType];

  if (!entry || !entry.enabled) {
    return [];
  }

  return Array.isArray(entry.channelIds) ? [...entry.channelIds] : [];
}

/**
 * Returns the union of channel IDs configured for a given event type across all domains.
 * Useful for global events (nginx_down) where no specific domain context exists.
 * @param {string} eventType
 * @returns {string[]}
 */
export function getAllDomainChannelIds(eventType) {
  if (!KNOWN_EVENT_TYPES.includes(eventType)) return [];

  let map;
  try {
    map = dbGet(DB_KEY);
  } catch {
    return [];
  }

  if (!map || typeof map !== 'object') return [];

  const ids = new Set();
  for (const domainConfig of Object.values(map)) {
    if (!domainConfig || typeof domainConfig !== 'object') continue;
    const entry = domainConfig[eventType];
    if (entry?.enabled && Array.isArray(entry.channelIds)) {
      for (const id of entry.channelIds) ids.add(id);
    }
  }

  return [...ids];
}

// ═══════════════════════════════════════════════════════════════════════════
// NOTIFICATION STATE TRACKING (deduplication + recovery)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * State key format: "{domain}:{eventType}" or "global:{eventType}" (for nginx_down)
 * State value: { status: 'up'|'down'|'unknown', lastNotifiedAt: timestamp, notifiedFor: 'up'|'down'|null }
 */

/**
 * Get the notification state map from database.
 * @returns {object}
 */
function getNotificationStateMap() {
  try {
    const map = dbGet(STATE_DB_KEY);
    return map && typeof map === 'object' ? map : {};
  } catch {
    return {};
  }
}

/**
 * Save the notification state map to database.
 * @param {object} map
 */
function saveNotificationStateMap(map) {
  dbSet(STATE_DB_KEY, map);
}

/**
 * Get notification state for a specific domain/event combination.
 * @param {string|null} domain - null for global events like nginx_down
 * @param {string} eventType
 * @returns {{ status: string, lastNotifiedAt: number|null, notifiedFor: string|null }}
 */
export function getNotificationState(domain, eventType) {
  const key = domain ? `${domain}:${eventType}` : `global:${eventType}`;
  const map = getNotificationStateMap();
  return map[key] || { status: 'unknown', lastNotifiedAt: null, notifiedFor: null };
}

/**
 * Set notification state for a specific domain/event combination.
 * @param {string|null} domain - null for global events
 * @param {string} eventType
 * @param {object} state - { status, lastNotifiedAt, notifiedFor }
 */
export function setNotificationState(domain, eventType, state) {
  const key = domain ? `${domain}:${eventType}` : `global:${eventType}`;
  const map = getNotificationStateMap();
  map[key] = {
    status: state.status || 'unknown',
    lastNotifiedAt: state.lastNotifiedAt || null,
    notifiedFor: state.notifiedFor || null,
  };
  saveNotificationStateMap(map);
}

/**
 * Result of checking if a notification should be sent.
 * @typedef {Object} NotificationDecision
 * @property {boolean} shouldNotify - Whether to send a notification
 * @property {string|null} reason - Why (e.g., 'state_changed', 'recovery', 'no_change')
 * @property {string} currentStatus - The new status ('up' or 'down')
 * @property {string|null} previousNotifiedFor - What we previously notified about
 */

/**
 * Determine if we should send a notification based on state changes.
 * Prevents spam by only sending when state changes.
 * Handles recovery notifications when transitioning from down → up.
 *
 * @param {string|null} domain - null for global events
 * @param {string} eventType
 * @param {string} currentStatus - 'up' or 'down'
 * @returns {NotificationDecision}
 */
export function shouldSendNotification(domain, eventType, currentStatus) {
  const previousState = getNotificationState(domain, eventType);
  const previousNotifiedFor = previousState.notifiedFor;

  // Normalize status to 'up' or 'down'
  const status = currentStatus === 'up' || currentStatus === 'down' ? currentStatus : 'unknown';

  console.log(`[domainNotifier] Checking notification: domain=${domain || 'global'}, event=${eventType}, status=${status}, prevNotifiedFor=${previousNotifiedFor}`);

  // First time seeing this domain/event - don't notify, just record state
  if (previousNotifiedFor === null || previousState.status === 'unknown') {
    console.log(`[domainNotifier] First check - recording state, no notification`);
    setNotificationState(domain, eventType, { status, lastNotifiedAt: null, notifiedFor: status });
    return { shouldNotify: false, reason: 'first_check', currentStatus: status, previousNotifiedFor: null };
  }

  // Status unchanged from what we already notified about
  if (previousNotifiedFor === status) {
    console.log(`[domainNotifier] No change - already notified for '${status}'`);
    return { shouldNotify: false, reason: 'no_change', currentStatus: status, previousNotifiedFor };
  }

  // Status changed!
  if (status === 'down' && previousNotifiedFor !== 'down') {
    // Transition: up → down (or unknown → down)
    console.log(`[domainNotifier] State changed: ${previousNotifiedFor} → down, will notify`);
    setNotificationState(domain, eventType, { status: 'down', lastNotifiedAt: Date.now(), notifiedFor: 'down' });
    return { shouldNotify: true, reason: 'state_changed', currentStatus: 'down', previousNotifiedFor };
  }

  if (status === 'up' && previousNotifiedFor === 'down') {
    // Transition: down → up (recovery!)
    console.log(`[domainNotifier] Recovery detected: down → up, will notify`);
    setNotificationState(domain, eventType, { status: 'up', lastNotifiedAt: Date.now(), notifiedFor: 'up' });
    return { shouldNotify: true, reason: 'recovery', currentStatus: 'up', previousNotifiedFor: 'down' };
  }

  // Edge case: up → up (but previousNotifiedFor was something else)
  // This shouldn't happen, but handle gracefully
  console.log(`[domainNotifier] Edge case: status=${status}, prevNotifiedFor=${previousNotifiedFor}`);
  setNotificationState(domain, eventType, { status, lastNotifiedAt: Date.now(), notifiedFor: status });
  return { shouldNotify: false, reason: 'edge_case', currentStatus: status, previousNotifiedFor };
}

/**
 * Clear notification state for a domain (useful for testing or manual reset).
 * @param {string|null} domain - null to clear global state, or specific domain
 * @param {string} eventType
 */
export function clearNotificationState(domain, eventType) {
  const key = domain ? `${domain}:${eventType}` : `global:${eventType}`;
  const map = getNotificationStateMap();
  delete map[key];
  saveNotificationStateMap(map);
}

/**
 * Clear all notification state (useful for testing).
 */
export function clearAllNotificationState() {
  dbSet(STATE_DB_KEY, {});
}

export { KNOWN_EVENT_TYPES };
