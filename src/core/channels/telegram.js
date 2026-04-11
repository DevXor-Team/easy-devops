/**
 * Telegram Notification Channel
 *
 * Sends notifications to Telegram via Bot API.
 * This module conforms to the channel interface defined in notifier.js:
 * - Exports async function send(event, channelConfig)
 * - channelConfig must contain { botToken, chatId }
 *
 * NO IMPORTS: fetch is global in Node 18+. This module does not import
 * from notifier.js or any other project files.
 */

/**
 * Escape HTML special characters for Telegram HTML parse mode.
 * @param {string} str - String to escape
 * @returns {string} HTML-safe string
 */
function escapeHtml(str) {
	if (!str) return '';
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

/**
 * Convert event type to a human-readable title.
 * e.g., 'domain_added' -> 'Domain Added'
 * @param {string} type - Event type
 * @returns {string} Formatted title
 */
function toTitle(type) {
	if (!type) return 'Notification';
	return type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Get severity emoji prefix for Telegram messages.
 * @param {string} severity - 'danger', 'warning', or undefined/other
 * @returns {string} Emoji prefix or empty string
 */
function severityPrefix(severity) {
	if (severity === 'danger') return '\uD83D\uDD34 DANGER';
	if (severity === 'warning') return '\u26A0\uFE0F WARNING';
	return '';
}

/**
 * Send a notification to Telegram via Bot API.
 *
 * @param {Object} event - The notification event
 * @param {string} event.type - Event type for message title
 * @param {string} [event.message] - Message to include
 * @param {string} [event.severity] - 'danger' or 'warning'
 * @param {string} [event.domain] - Domain to include
 * @param {string} [event.timestamp] - ISO timestamp (defaults to now)
 * @param {Object} channelConfig - Channel configuration
 * @param {string} channelConfig.botToken - Telegram bot token
 * @param {string} channelConfig.chatId - Telegram chat ID
 * @param {string} [channelConfig.message] - Optional prefix to prepend to message
 * @returns {Promise<void>}
 */
export async function send(event, channelConfig) {
	// Early return if not configured - no throw, just exit silently
	if (!channelConfig?.botToken || !channelConfig?.chatId) return;
	try {
		// Prepend message prefix if configured
		if (channelConfig?.message) {
			event = {
				...event,
				message: channelConfig.message + '\n' + (event.message || '')
			};
		}

		// Build message text using HTML formatting
		const lines = [];

		// Add severity prefix if present
		const prefix = severityPrefix(event?.severity);
		if (prefix) lines.push(`<b>${prefix}</b>`);

		// Add event type as title
		lines.push(`<b>${escapeHtml(toTitle(event?.type))}</b>`);

		// Add message body if present (HTML escaped)
		if (event?.message) {
			lines.push(escapeHtml(event.message));
		}

		// Add domain if present (as inline code)
		if (event?.domain) {
			lines.push(`Domain: <code>${escapeHtml(event.domain)}</code>`);
		}

		const text = lines.join('\n');

		// Build Telegram Bot API URL
		const url = `https://api.telegram.org/bot${channelConfig.botToken}/sendMessage`;

		// POST to Telegram API using built-in fetch (Node 18+)
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				chat_id: channelConfig.chatId,
				text,
				parse_mode: 'HTML',
			}),
		});
		// Throw on non-2xx response
		if (!res.ok) {
			throw new Error(`Telegram API returned ${res.status} ${res.statusText}`);
		}
	} catch (err) {
		// Redact bot token from error message to prevent credential leakage
		const safeMsg = err.message.replace(/bot[^/]+\//g, 'bot[REDACTED]/');
		console.error('[telegram] send failed:', safeMsg);
		// DO NOT re-throw - channel isolation guarantees other channels still work
	}
}
