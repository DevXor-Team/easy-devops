/**
 * cli/menus/update.js
 *
 * Check for updates and upgrade easy-devops in place.
 *
 * Flow:
 * 1. Fetch latest version from npm registry
 * 2. If an update is available, offer to install it
 * 3. Before installing: record dashboard running state in DB
 *    (key: 'update-pre-dashboard') so it survives a crash mid-update
 * 4. Stop dashboard if it was running
 * 5. Close database connection
 * 6. Spawn an external update script that runs npm install
 *    after this process exits (to avoid EBUSY on Windows)
 * 7. This process exits; update script runs
 * 8. On next launch, recoverIfNeeded restarts dashboard if needed
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { spawn } from 'child_process';
import { run } from '../../core/shell.js';
import { dbGet, dbSet, closeDb } from '../../core/db.js';
import { loadConfig } from '../../core/config.js';
import { getDashboardStatus, stopDashboard } from './dashboard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { version: currentVersion } = require('../../package.json');

const isWindows = process.platform === 'win32';

// ─── Version helpers ──────────────────────────────────────────────────────────

async function fetchLatestVersion() {
  const result = await run('npm view easy-devops version', { timeout: 20000 });
  if (result.success && result.stdout.trim()) return result.stdout.trim();
  return null;
}

function isNewer(latest, current) {
  const parse = v => v.replace(/^v/, '').split('.').map(Number);
  const [la, lb, lc] = parse(latest);
  const [ca, cb, cc] = parse(current);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}

// ─── Recover interrupted update ───────────────────────────────────────────────
// If a previous update crashed after stopping the dashboard but before restarting
// it, the key 'update-pre-dashboard' is still set. Offer to restart it.

async function recoverIfNeeded() {
  const saved = dbGet('update-pre-dashboard');
  if (!saved?.wasRunning) return;

  console.log(chalk.yellow('\n A previous update left the dashboard stopped.'));
  const { restart } = await inquirer.prompt([{
    type: 'confirm',
    name: 'restart',
    message: 'Restart the dashboard now?',
    default: true,
  }]);

  if (restart) {
    // Dynamic import to avoid circular dependency and ensure fresh state
    const { startDashboard } = await import('./dashboard.js');
    const port = saved.port || loadConfig().dashboardPort;
    const sp = ora(`Starting dashboard on port ${port}...`).start();
    const res = await startDashboard(port);
    res.success
      ? sp.succeed(`Dashboard restarted on port ${port}`)
      : sp.fail('Could not restart dashboard — use the Dashboard menu');
  }

  dbSet('update-pre-dashboard', null);
}

// ─── Perform update ───────────────────────────────────────────────────────────

/**
 * Creates and spawns an external update script that runs after this process exits.
 * This is necessary on Windows because better-sqlite3's native module stays locked
 * as long as any Node.js process has the database open.
 */
async function performUpdate(latestVersion) {
  // Step 1 — snapshot dashboard state and persist it
  const status = await getDashboardStatus();
  dbSet('update-pre-dashboard', {
    wasRunning: status.running,
    pid: status.pid,
    port: status.port,
  });

  // Step 2 — stop dashboard if running (it has its own DB connection)
  if (status.running) {
    const sp = ora('Stopping dashboard...').start();
    await stopDashboard(status.pid);
    sp.succeed('Dashboard stopped');
    // Give the dashboard process a moment to fully terminate
    await new Promise(r => setTimeout(r, 2000));
  }

  // Step 3 — close this process's database connection
  closeDb();

  // Step 4 — create an external update script and spawn it
  // The script will run npm install after this process exits
  const updateScriptPS = `
$ProgressPreference = 'SilentlyContinue'
Write-Host ""
Write-Host "Installing easy-devops@${latestVersion}..." -ForegroundColor Cyan
Write-Host ""
npm install -g easy-devops@${latestVersion}
if ($LASTEXITCODE -eq 0) {
  Write-Host ""
  Write-Host "Successfully updated to v${latestVersion}" -ForegroundColor Green
  Write-Host "Run 'easy-devops' to start the new version." -ForegroundColor Gray
} else {
  Write-Host ""
  Write-Host "Update failed. Please try again or update manually:" -ForegroundColor Red
  Write-Host "  npm install -g easy-devops@${latestVersion}" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "Press any key to close this window..." -ForegroundColor Gray
$null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
`;

  const updateScriptBash = `#!/bin/bash
echo ""
echo -e "\\033[36mInstalling easy-devops@${latestVersion}...\\033[0m"
echo ""
npm install -g easy-devops@${latestVersion}
if [ $? -eq 0 ]; then
  echo ""
  echo -e "\\033[32mSuccessfully updated to v${latestVersion}\\033[0m"
  echo -e "\\033[90mRun 'easy-devops' to start the new version.\\033[0m"
else
  echo ""
  echo -e "\\033[31mUpdate failed. Please try again or update manually:\\033[0m"
  echo -e "\\033[33m  npm install -g easy-devops@${latestVersion}\\033[0m"
fi
echo ""
read -p "Press Enter to close this window..."
`;

  console.log(chalk.cyan('\n Starting external update process...'));
  console.log(chalk.gray(' A new window will open to complete the update.'));
  console.log(chalk.gray(' This window will close after the update starts.\n'));

  if (isWindows) {
    // Write script to temp file and run in new PowerShell window
    const tempDir = process.env.TEMP || 'C:\\Windows\\Temp';
    const tempScript = path.join(tempDir, 'easy-devops-update.ps1');
    fs.writeFileSync(tempScript, updateScriptPS, 'utf8');

    // Run in a new window, this process will exit
    spawn('powershell.exe', [
      '-NoExit',
      '-ExecutionPolicy', 'Bypass',
      '-File', tempScript
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    }).unref();

    // Clean up hint
    console.log(chalk.gray(` Update script: ${tempScript}`));
  } else {
    // On Linux/Mac, run in a new terminal window if possible
    const tempScript = '/tmp/easy-devops-update.sh';
    fs.writeFileSync(tempScript, updateScriptBash, 'utf8');
    fs.chmodSync(tempScript, '755');

    // Try common terminal emulators
    const terminals = [
      ['gnome-terminal', '--', 'bash', '-c', updateScriptBash],
      ['xterm', '-e', 'bash', '-c', updateScriptBash],
      ['konsole', '-e', 'bash', '-c', updateScriptBash],
    ];
    let launched = false;

    for (const [cmd, ...args] of terminals) {
      try {
        spawn(cmd, args, {
          detached: true,
          stdio: 'ignore'
        }).unref();
        launched = true;
        break;
      } catch { /* try next */ }
    }

    if (!launched) {
      // Fallback: just run npm directly in this terminal
      console.log(chalk.yellow('\nRunning update in this window...'));
      const result = await run(`npm install -g easy-devops@${latestVersion}`, { timeout: 120000 });
      if (result.success) {
        console.log(chalk.green(`\n Successfully updated to v${latestVersion}`));
      } else {
        console.log(chalk.red('\n Update failed:'));
        console.log(result.stderr || result.stdout);
      }
      return result.success;
    }
  }

  // Give a moment for the external process to start
  await new Promise(r => setTimeout(r, 1000));

  console.log(chalk.green('\n Update process launched.'));
  console.log(chalk.gray(' Complete the update in the new window, then run: easy-devops'));
  console.log(chalk.gray(' If the dashboard was running, it will be restarted on next launch.\n'));

  return true;
}

// ─── Menu ─────────────────────────────────────────────────────────────────────

export default async function updateMenu() {
  // Recover from a crashed previous update first
  await recoverIfNeeded();

  const spinner = ora('Checking for updates...').start();
  const latestVersion = await fetchLatestVersion();
  spinner.stop();

  console.log(chalk.bold('\n Check for Updates'));
  console.log(chalk.gray(' ' + '─'.repeat(40)));
  console.log(` Current version : ${chalk.cyan('v' + currentVersion)}`);

  if (!latestVersion) {
    console.log(chalk.yellow(' Could not reach npm registry. Check your internet connection.\n'));
    await inquirer.prompt([{ type: 'input', name: '_', message: 'Press Enter to go back...' }]);
    return;
  }

  const updateAvailable = isNewer(latestVersion, currentVersion);

  if (updateAvailable) {
    console.log(` Latest version : ${chalk.green('v' + latestVersion)} ${chalk.yellow('← update available')}\n`);
  } else {
    console.log(` Latest version : ${chalk.green('v' + latestVersion)} ${chalk.gray('✓ up to date')}\n`);
  }

  const choices = updateAvailable
    ? [`Update to v${latestVersion}`, new inquirer.Separator(), '← Back']
    : ['← Back'];

  let choice;
  try {
    ({ choice } = await inquirer.prompt([{
      type: 'list',
      name: 'choice',
      message: 'Select an option:',
      choices,
    }]));
  } catch (err) {
    if (err.name === 'ExitPromptError') return;
    throw err;
  }

  if (choice === `Update to v${latestVersion}`) {
    await performUpdate(latestVersion);
    try {
      await inquirer.prompt([{ type: 'input', name: '_', message: 'Press Enter to exit...' }]);
    } catch { /* ExitPromptError */ }
  }
}
