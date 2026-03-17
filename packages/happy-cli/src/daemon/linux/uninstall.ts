import chalk from 'chalk';
import { uninstallService, SERVICE_NAME } from './systemd';

export async function uninstall(): Promise<void> {
  uninstallService();
  console.log(chalk.green(`✓ Service ${SERVICE_NAME} stopped, disabled and removed`));
}
