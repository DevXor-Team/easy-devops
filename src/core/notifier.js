/**
 * Notification Dispatcher Core
 *
 * Named-channel registry model. Channels are stored as an array of objects:
 *   { id, name, type, ...typeSpecificFields }
 *
 * sendNotification(event, channelIds) looks up each ID, finds its type, and
 * dispatches to src/core/channels/{type}.js — the send() interface is unchanged.
 */

import { dbGet, dbSet } from './db.js';

const CHANNELS_KEY = 'notification_channels';

/**
 * Load the channel list from SQLite.
 * @returns {Array} Array of channel objects (empty array if none saved)
 */
export function loadChannels() {
  const stored = dbGet(CHANNELS_KEY);
  return Array.isArray(stored) ? stored : [];
}

/**
 * Persist the channel list to SQLite.
 * @param {Array} channels
 */
export function saveChannels(channels) {
  dbSet(CHANNELS_KEY, channels);
}

/**
 * Find a single channel by ID.
 * @param {string} id
 * @returns {Object|null}
 */
export function getChannelById(id) {
  return loadChannels().find((ch) => ch.id === id) ?? null;
}

/**
 * Send a notification to a specific set of channels identified by ID.
 * Each channel's send() is called in a try/catch — one failure won't block others.
 * Passing null or an empty array is a no-op (dashboard-only path).
 *
 * @param {Object} event         - Notification event (type, message, severity, domain, timestamp)
 * @param {string[]|null} channelIds - Array of channel IDs to dispatch to
 */
export async function sendNotification(event, channelIds = null) {
  if (!channelIds || channelIds.length === 0) return;

  const channels = loadChannels();

  for (const id of channelIds) {
    const channel = channels.find((ch) => ch.id === id);
    if (!channel) continue;

    try {
      const mod = await import(
        new URL(`./channels/${channel.type}.js`, import.meta.url)
      );

      if (typeof mod.send !== 'function') {
        console.error(`[notifier] channel type "${channel.type}" missing send()`);
        continue;
      }

      await mod.send(event, channel);
    } catch (err) {
      console.error(`[notifier] channel "${channel.name}" (${channel.type}):`, err.message);
    }
  }
}
