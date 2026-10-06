import chalk from 'chalk';
import {
    getDefaultEditor,
    setDefaultEditor,
    getConfigPath,
    getCopyPaths,
    setCopyPaths,
    getDefaultPackageManager,
    setDefaultPackageManager,
} from '../config.js';

type ConfigAction = 'get' | 'set' | 'path';

export async function configHandler(action: ConfigAction, key?: string, value?: string) {
    try {
        switch (action) {
            case 'get':
                if (key === 'editor') {
                    const editor = getDefaultEditor();
                    console.log(chalk.blue(`Default editor is currently set to: ${chalk.bold(editor)}`));
                } else if (key === 'package-manager') {
                    const packageManager = getDefaultPackageManager();
                    console.log(chalk.blue(`Default package manager is currently set to: ${chalk.bold(packageManager)}`));
                } else if (key === 'copy-paths') {
                    const copyPaths = getCopyPaths();
                    if (!copyPaths) {
                        console.log(chalk.blue('No copy-paths configured.'));
                    } else {
                        console.log(chalk.blue(`Copy-paths: ${chalk.bold(copyPaths)}`));
                    }
                } else {
                    console.error(chalk.red(`Unknown configuration key to get: ${key}`));
                    process.exit(1);
                }
                break;
            case 'set':
                if (key === 'editor' && value) {
                    setDefaultEditor(value);
                    console.log(chalk.green(`Default editor set to: ${chalk.bold(value)}`));
                } else if (key === 'editor') {
                    console.error(chalk.red(`You must provide an editor name.`));
                    process.exit(1);
                } else if (key === 'package-manager' && value) {
                    setDefaultPackageManager(value);
                    console.log(chalk.green(`Default package manager set to: ${chalk.bold(value)}`));
                } else if (key === 'package-manager') {
                    console.error(chalk.red(`You must provide a package manager (npm, pnpm, bun, uv, skip, auto, etc.).`));
                    process.exit(1);
                } else if (key === 'copy-paths' && value !== undefined) {
                    setCopyPaths(value);
                    const paths = getCopyPaths();
                    if (!paths) {
                        console.log(chalk.green('Copy-paths cleared.'));
                    } else {
                        console.log(chalk.green(`Copy-paths set to: ${chalk.bold(paths)}`));
                    }
                } else if (key === 'copy-paths') {
                    console.error(chalk.red(`You must provide a comma-separated list of paths.`));
                    process.exit(1);
                } else {
                    console.error(chalk.red(`Unknown configuration key to set: ${key}`));
                    process.exit(1);
                }
                break;
            case 'path':
                const configPath = getConfigPath();
                console.log(chalk.blue(`Configuration file path: ${configPath}`));
                break;
            default:
                console.error(chalk.red(`Unknown config action: ${action}`));
                process.exit(1);
        }
    } catch (error) {
        if (error instanceof Error) {
            console.error(chalk.red('Configuration command failed:'), error.message);
        } else {
            console.error(chalk.red('Configuration command failed:'), error);
        }
        process.exit(1);
    }
} 
