import { tavernPlugin } from './tavern';

export * from './sdk';
export * from './tavern';
export { liarsBarModule } from './games/liars-bar';

export const plugins = [
  tavernPlugin,
] as const;
