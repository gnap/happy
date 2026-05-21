import chalk from 'chalk';
import { existsSync } from 'node:fs';
import {
  envFilePath,
  installService,
  isServiceInstalled,
  isSystemdAvailable,
  SERVICE_NAME,
  serviceFilePath,
  startService,
  tryEnableUserLinger,
} from './systemd';
import { stopDaemon } from '@/daemon/controlClient';

export async function install(): Promise<void> {
  if (!isSystemdAvailable()) {
    throw new Error('systemd is not available on this system');
  }

  if (isServiceInstalled()) {
    console.log(chalk.yellow(`Service ${SERVICE_NAME} already installed, reinstalling...`));
  }

  // Stop any running daemon (regardless of how it was started) before handing
  // control to systemd. This ensures the new service starts with a clean slate.
  try {
    await stopDaemon();
    console.log(chalk.gray('  Stopped existing daemon'));
  } catch {}

  const envFileExisted = existsSync(envFilePath());
  installService();
  console.log(chalk.green(`✓ Service file written to ${serviceFilePath()}`));
  if (envFileExisted) {
    console.log(chalk.gray(`  Reusing existing env file ${envFilePath()}`));
  } else {
    console.log(chalk.green(`✓ Env file seeded at ${envFilePath()} (chmod 600)`));
  }
  console.log(chalk.green(`✓ Service enabled (will auto-start on login)`));

  const linger = tryEnableUserLinger();
  if (linger.ok) {
    console.log(
      chalk.green(
        linger.alreadyEnabled
          ? '✓ User linger already enabled (daemon survives logout)'
          : '✓ Enabled user linger (daemon survives logout)',
      ),
    );
  } else {
    console.log(chalk.yellow(`  Could not enable linger (daemon stops on logout): ${linger.error}`));
    console.log(chalk.gray('  Fallback: systemd user service still installed (starts on login).'));
    console.log(chalk.gray('  To enable logout survival: loginctl enable-linger $USER'));
  }

  await new Promise(resolve => setTimeout(resolve, 300));

  try {
    startService();
    console.log(chalk.green(`✓ Daemon started via systemd`));
  } catch (e: any) {
    console.log(chalk.yellow(`  Could not start service immediately: ${e.message}`));
    console.log(chalk.gray(`  Run: systemctl --user start ${SERVICE_NAME}`));
  }

  console.log('');
  console.log(chalk.bold('Useful commands:'));
  console.log(`  systemctl --user status  ${SERVICE_NAME}`);
  console.log(`  systemctl --user stop    ${SERVICE_NAME}`);
  console.log(`  systemctl --user start   ${SERVICE_NAME}`);
  console.log(`  journalctl --user -u     ${SERVICE_NAME} -f`);
  console.log('');
  console.log(chalk.bold('Daemon env file (single source of truth):'));
  console.log(`  ${envFilePath()}`);
  console.log(chalk.gray('  Edit to add ANTHROPIC_*, model overrides, custom PATH, etc.'));
  console.log(chalk.gray(`  Then: systemctl --user restart ${SERVICE_NAME}`));
}
