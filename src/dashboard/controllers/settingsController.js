import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { loadConfig, saveConfig } from '../../core/config.js';
import { validatePort, validateEmail } from '../../core/validators.js';
import { run, runWithStdin } from '../../core/shell.js';
import { checkPermissionsConfigured } from '../../core/permissions.js';
import { dbGet, dbSet } from '../../core/db.js';
import { loadChannels, saveChannels, sendNotification } from '../../core/notifier.js';

class SettingsController {
	get(req, res) {
		try {
			const config = loadConfig();
			const { dashboardPort, nginxDir, sslDir, acmeEmail } = config;
			res.json({
				dashboardPort,
				nginxDir,
				sslDir,
				acmeEmail,
				platform: process.platform === 'win32' ? 'win32' : 'linux',
			});
		} catch (err) {
			res.status(500).json({ error: 'Internal server error' });
		}
	}

	update(req, res) {
		try {
			const { dashboardPort, dashboardPassword, nginxDir, sslDir, acmeEmail } = req.body;

			if (dashboardPort !== undefined) {
				const portError = validatePort(parseInt(dashboardPort, 10));
				if (portError) return res.status(400).json({ error: portError });
			}

			if (dashboardPassword !== undefined && typeof dashboardPassword !== 'string') {
				return res.status(400).json({ error: 'Password must be a string' });
			}

			if (nginxDir !== undefined && (typeof nginxDir !== 'string' || nginxDir.trim() === '')) {
				return res.status(400).json({ error: 'Nginx directory must be a non-empty string' });
			}
			if (sslDir !== undefined && (typeof sslDir !== 'string' || sslDir.trim() === '')) {
				return res.status(400).json({ error: 'SSL directory must be a non-empty string' });
			}

			if (acmeEmail !== undefined) {
				const emailError = validateEmail(acmeEmail);
				if (emailError) return res.status(400).json({ error: emailError });
			}

			const currentConfig = loadConfig();
			const updates = {};

			if (dashboardPort !== undefined) updates.dashboardPort = parseInt(dashboardPort, 10);
			if (dashboardPassword !== undefined) updates.dashboardPassword = dashboardPassword;
			if (nginxDir !== undefined) updates.nginxDir = nginxDir.trim();
			if (sslDir !== undefined) updates.sslDir = sslDir.trim();
			if (acmeEmail !== undefined) updates.acmeEmail = acmeEmail.trim();

			saveConfig({ ...currentConfig, ...updates });
			res.json({ success: true });
		} catch (err) {
			res.status(500).json({ error: 'Internal server error' });
		}
	}

	async getPermissions(req, res) {
		if (process.platform === 'win32') return res.json({ configured: true });
		try {
			const configured = await checkPermissionsConfigured();
			res.json({ configured });
		} catch {
			res.json({ configured: false });
		}
	}

	async setupPermissions(req, res) {
		if (process.platform === 'win32') {
			return res.status(400).json({ error: 'Not applicable on Windows' });
		}

		const { password } = req.body ?? {};
		if (!password || typeof password !== 'string') {
			return res.status(400).json({ error: 'Password is required' });
		}

		const whichResult = await run('which nginx');
		if (!whichResult.success || !whichResult.stdout.trim()) {
			return res.status(500).json({ error: 'nginx not found. Is nginx installed?' });
		}
		const nginxPath = whichResult.stdout.trim().split('\n')[0].trim();
		const user = os.userInfo().username;

		const sudoRules = [
			'/usr/bin/systemctl start nginx',
			'/usr/bin/systemctl stop nginx',
			'/usr/bin/systemctl reload nginx',
			'/usr/bin/systemctl restart nginx',
			'/usr/bin/systemctl',
			nginxPath,
			`${nginxPath} -t`,
			`${nginxPath} -s reload`,
			`${nginxPath} -s stop`,
			`${nginxPath} -s quit`,
			'/usr/bin/certbot',
			'/usr/bin/mkdir',
			'/usr/bin/cp',
			'/usr/bin/chmod',
			'/usr/bin/chown',
			'/usr/bin/tee',
		].join(', ');

		const sudoersContent = `${user} ALL=(ALL) NOPASSWD: ${sudoRules}\n`;

		const tmpFile = path.join('/tmp', `easy-devops-sudoers-${Date.now()}`);
		try {
			await fs.writeFile(tmpFile, sudoersContent, { mode: 0o600 });
		} catch (err) {
			return res.status(500).json({ error: 'Failed to write temp file', output: err.message });
		}

		const setupCmd = [
			`mkdir -p /etc/easy-devops /var/log/easy-devops`,
			`chown ${user}:${user} /etc/easy-devops /var/log/easy-devops`,
			`chown -R ${user}:${user} /etc/nginx/conf.d 2>/dev/null || true`,
			`cp '${tmpFile}' /etc/sudoers.d/easy-devops`,
			`chmod 440 /etc/sudoers.d/easy-devops`,
		].join(' && ');

		const result = await runWithStdin('sudo', ['-S', 'bash', '-c', setupCmd], password + '\n');
		await fs.unlink(tmpFile).catch(() => {});

		if (!result.success) {
			const output = result.stderr || result.stdout;
			const wrongPassword = output.includes('incorrect password') || output.includes('Sorry, try again') || output.includes('3 incorrect');
			return res.status(wrongPassword ? 401 : 500).json({
				error: wrongPassword ? 'Incorrect password' : 'Setup failed',
				output,
			});
		}

		res.json({ success: true });
	}

	backup(req, res) {
		try {
			const config = loadConfig();
			const domains = dbGet('domains') || [];
			const { dashboardPassword: _pw, ...safeConfig } = config;
			const backup = {
				version: 1,
				exportedAt: new Date().toISOString(),
				config: safeConfig,
				domains,
			};
			res.setHeader('Content-Disposition', `attachment; filename="easy-devops-backup-${Date.now()}.json"`);
			res.setHeader('Content-Type', 'application/json');
			res.json(backup);
		} catch (err) {
			res.status(500).json({ error: 'Export failed' });
		}
	}

	restore(req, res) {
		try {
			const { config, domains } = req.body ?? {};
			if (!config || typeof config !== 'object') {
				return res.status(400).json({ error: 'Invalid backup: missing config' });
			}
			const current = loadConfig();
			const merged = { ...current, ...config, dashboardPassword: current.dashboardPassword };
			saveConfig(merged);
			if (Array.isArray(domains)) {
				dbSet('domains', domains);
			}
			res.json({ success: true });
		} catch (err) {
			res.status(500).json({ error: 'Restore failed' });
		}
	}

	// ── Notification Channel CRUD ─────────────────────────────────────────────

	/**
	 * GET /api/settings/channels
	 * Returns the full channel list.
	 */
	getChannels(req, res) {
		try {
			res.json(loadChannels());
		} catch (err) {
			res.status(500).json({ error: 'Internal server error' });
		}
	}

	/**
	 * POST /api/settings/channels
	 * Creates a new named channel.
	 */
	createChannel(req, res) {
		try {
			const { name, type, webhookUrl, botToken, chatId, message } = req.body ?? {};

			if (!name || typeof name !== 'string' || !name.trim()) {
				return res.status(400).json({ error: 'Channel name is required' });
			}
			if (!['discord', 'telegram'].includes(type)) {
				return res.status(400).json({ error: 'Channel type must be discord or telegram' });
			}
			if (type === 'discord' && (!webhookUrl || !webhookUrl.trim())) {
				return res.status(400).json({ error: 'Discord channels require a webhookUrl' });
			}
			if (type === 'telegram') {
				if (!botToken || !botToken.trim()) {
					return res.status(400).json({ error: 'Telegram channels require a botToken' });
				}
				if (!chatId || !chatId.trim()) {
					return res.status(400).json({ error: 'Telegram channels require a chatId' });
				}
			}

			const channel = {
				id: crypto.randomUUID(),
				name: name.trim(),
				type,
				...(type === 'discord' ? { webhookUrl: webhookUrl.trim() } : {}),
				...(type === 'telegram' ? { botToken: botToken.trim(), chatId: chatId.trim() } : {}),
				...(message && message.trim() ? { message: message.trim() } : {}),
			};

			const channels = loadChannels();
			channels.push(channel);
			saveChannels(channels);

			res.status(201).json(channel);
		} catch (err) {
			res.status(500).json({ error: 'Internal server error' });
		}
	}

	/**
	 * PUT /api/settings/channels/:id
	 * Updates name and/or credentials for an existing channel.
	 * Type is immutable after creation.
	 */
	updateChannel(req, res) {
		try {
			const { id } = req.params;
			const channels = loadChannels();
			const idx = channels.findIndex((ch) => ch.id === id);
			if (idx === -1) return res.status(404).json({ error: 'Channel not found' });

			const existing = channels[idx];
			const { name, webhookUrl, botToken, chatId, message } = req.body ?? {};

			const updated = { ...existing };
			if (name !== undefined) {
				if (!name.trim()) return res.status(400).json({ error: 'Channel name cannot be empty' });
				updated.name = name.trim();
			}
			if (existing.type === 'discord' && webhookUrl !== undefined) {
				updated.webhookUrl = webhookUrl.trim();
			}
			if (existing.type === 'telegram') {
				if (botToken !== undefined) updated.botToken = botToken.trim();
				if (chatId !== undefined) updated.chatId = chatId.trim();
			}

			// Handle message field - allow clearing by setting to empty string
			if (message !== undefined) {
				if (message && message.trim()) {
					updated.message = message.trim();
				} else {
					delete updated.message;
				}
			}

			channels[idx] = updated;
			saveChannels(channels);
			res.json(updated);
		} catch (err) {
			res.status(500).json({ error: 'Internal server error' });
		}
	}

	/**
	 * DELETE /api/settings/channels/:id
	 */
	deleteChannel(req, res) {
		try {
			const { id } = req.params;
			const channels = loadChannels();
			const idx = channels.findIndex((ch) => ch.id === id);
			if (idx === -1) return res.status(404).json({ error: 'Channel not found' });

			channels.splice(idx, 1);
			saveChannels(channels);
			res.json({ deleted: id });
		} catch (err) {
			res.status(500).json({ error: 'Internal server error' });
		}
	}

	/**
	 * POST /api/settings/channels/:id/test
	 * Sends a test notification to a single channel.
	 */
	async testChannel(req, res) {
		try {
			const { id } = req.params;
			const channels = loadChannels();
			if (!channels.find((ch) => ch.id === id)) {
				return res.status(404).json({ error: 'Channel not found' });
			}

			await sendNotification(
				{
					type: 'test',
					message: 'Test notification from Easy DevOps. This channel is working correctly.',
					timestamp: new Date().toISOString(),
				},
				[id]
			);

			res.json({ success: true });
		} catch (err) {
			res.status(500).json({ error: err.message || 'Failed to send test notification' });
		}
	}
}

export default SettingsController;
