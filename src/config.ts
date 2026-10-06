import Conf from 'conf';

// Define the structure of the configuration
interface ConfigSchema {
    defaultEditor: string;
    extraCopyPaths: string[];
    defaultPackageManager: string;
}

// Git-ignored local files a fresh worktree needs to be usable. Tracked files
// come along via git automatically; these do not. Patterns support globs
// (`*`, `?`) and match by basename at any depth (see copyEnvFilesAndExtras).
// `.env*` files are always copied separately, so they're not listed here.
export const DEFAULT_COPY_PATHS: string[] = [
    '.npmrc',                        // private-registry auth — installs fail without it
    'app.db', 'dev.db',              // local SQLite / Prisma DBs
    'settings.local.json',           // Claude Code local permissions
    '.secrets.env', '.config.env',   // local secrets not caught by .env*
    'service-account.json',          // GCP credentials
    '*.pem', '*.key',                // GitHub App keys + DB/customer certs (glob; duplicates secrets locally)
    '.claude', '.codex', '.agents', '.opencode', // agent config dirs (mostly git-tracked; copied just in case)
];

// Initialize conf with a schema and project name
// Using the package name ensures a unique storage namespace
const schema = {
    defaultEditor: {
        type: 'string',
        default: 'none', // Don't open an editor by default
    },
    extraCopyPaths: {
        type: 'array',
        default: DEFAULT_COPY_PATHS,
        items: {
            type: 'string',
        },
    },
    defaultPackageManager: {
        type: 'string',
        default: 'auto', // Auto-detect by default
    },
} as const;

const config = new Conf<ConfigSchema>({
    // Pinned to the pre-rename package name so existing settings keep loading.
    projectName: '@gal064/dev',
    schema,
});

// Function to get the default editor
export function getDefaultEditor(): string {
    return config.get('defaultEditor');
}

// Function to set the default editor
export function setDefaultEditor(editor: string): void {
    config.set('defaultEditor', editor);
}

// Resolve the editor to open a worktree in, honoring an explicit CLI override
// then the configured default. Returns null when no editor should be opened
// (the `none`/`skip`/`false` sentinels, or an empty value).
export function resolveEditor(optionEditor?: string): string | null {
    const value = (optionEditor?.trim() || getDefaultEditor()).trim();
    const normalized = value.toLowerCase();
    if (!normalized || normalized === 'none' || normalized === 'skip' || normalized === 'false') {
        return null;
    }
    return value;
}

// Function to get the path to the config file (for debugging/info)
export function getConfigPath(): string {
    return config.path;
}

export function getExtraCopyPaths(): string[] {
    // Always include the built-in defaults so a user-set copy-paths list adds to
    // the load-bearing baseline (e.g. `.npmrc`) rather than replacing it.
    const stored = config.get('extraCopyPaths');
    return Array.from(new Set([...DEFAULT_COPY_PATHS, ...stored]));
}

// Get copy-paths as comma-separated string
export function getCopyPaths(): string {
    const paths = getExtraCopyPaths();
    return paths.join(',');
}

// Set copy-paths from comma-separated string
export function setCopyPaths(value: string): void {
    const trimmed = value.trim();
    if (!trimmed) {
        config.set('extraCopyPaths', []);
        return;
    }

    // Split by comma and trim each path
    const paths = trimmed
        .split(',')
        .map(p => p.trim())
        .filter(p => p.length > 0);

    // Remove duplicates
    const uniquePaths = Array.from(new Set(paths));
    config.set('extraCopyPaths', uniquePaths);
}

export function getDefaultPackageManager(): string {
    return config.get('defaultPackageManager');
}

export function setDefaultPackageManager(manager: string): void {
    config.set('defaultPackageManager', manager);
}
