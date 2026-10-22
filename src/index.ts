// Static registry of plugin modules. LuckyBot imports this list directly;
// modules are never discovered from the filesystem at runtime.
export const gameModules: readonly unknown[] = [];
