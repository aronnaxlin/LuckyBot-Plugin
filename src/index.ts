import { tavernPlugin } from './tavern';
import { webPlugin } from './web';

export * from './sdk';
export * from './tavern';
export * from './web';
export { liarsBarModule } from './games/liars-bar';

export const plugins = [
  tavernPlugin,
  webPlugin,
] as const;
