/**
 * Discord Notification Channel
 *
 * Sends notifications to Discord via webhook using discord.js.
 * This module conforms to the channel interface defined in notifier.js:
 * - Exports async function send(event, channelConfig)
 * - channelConfig must contain { webhookUrl }
 *
 * NO IMPORTS from other project files.
 */

import { WebhookClient, EmbedBuilder } from 'discord.js';

const SEVERITY_COLORS = {
	danger: 0xE74C3C, // red
	warning: 0xFFFF00, // yellow
};
const DEFAULT_COLOR = 0x3498DB; // blue

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
 * Send a notification to Discord via webhook.
 *
 * @param {Object} event - The notification event
 * @param {string} event.type - Event type for embed title
 * @param {string} [event.message] - Message to include in description
 * @param {string} [event.severity] - 'danger' (red) or 'warning' (yellow)
 * @param {string} [event.domain] - Domain to include in description
 * @param {string} [event.timestamp] - ISO timestamp (defaults to now)
 * @param {Object} channelConfig - Channel configuration
 * @param {string} channelConfig.webhookUrl - Discord webhook URL
 * @param {string} [channelConfig.message] - Optional prefix to prepend to message
 * @returns {Promise<void>}
 */
export async function send(event, channelConfig) {
	// Early return if not configured - no throw, just exit silently
	if (!channelConfig?.webhookUrl) return;

	// Determine embed colour based on severity
	const color = SEVERITY_COLORS[event?.severity] ?? DEFAULT_COLOR;

	// Build description from available fields
	const lines = [];
	if (event?.message) lines.push(event.message);
	if (event?.domain) lines.push(`Domain: \`${event.domain}\``);
	const description = lines.join('\n') || 'No additional details.';

	// Build Discord embed using EmbedBuilder
	const embed = new EmbedBuilder()
		.setAuthor({ name: 'Easy DevOps', iconURL: 'https://raw.githubusercontent.com/omar00050/Easy-DevOps/main/src/dashboard/public/img/icon_b.png' })
		.setTitle(toTitle(event?.type))
		.setDescription(description)
		.setColor(color)
		.setFooter({ text: 'Easy DevOps' })
		.setTimestamp(event?.timestamp ? new Date(event.timestamp) : new Date());

	// Send via WebhookClient
	// The message prefix (e.g. role mention) goes in `content`, not the embed,
	// because Discord only resolves mentions in message content, not inside embeds.
	const webhook = new WebhookClient({ url: channelConfig.webhookUrl });
	await webhook.send({
		content: channelConfig.message || undefined,
		embeds: [embed],
		username: 'Easy DevOps logs',
		avatarURL: 'https://raw.githubusercontent.com/omar00050/Easy-DevOps/main/src/dashboard/public/img/icon_b.png',
	});
}
