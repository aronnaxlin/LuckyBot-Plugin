import { describe, expect, it } from 'vitest';

import { webPlugin } from './index';
import type { PluginContext } from '../sdk';
import type { WebPluginConfig } from './types';

describe('webPlugin', () => {
  const dummyCapabilities: any = {
    callModel: () => Promise.resolve(''),
    http: { route: () => {} },
    chat: { publish: () => {} },
    scene: { enter: () => {}, exit: () => {} },
    storage: { rootDir: '' },
    log: { log: () => {}, warn: () => {}, error: () => {}, debug: () => {}, withFields: () => dummyCapabilities.log, withError: () => dummyCapabilities.log },
    media: { send: () => Promise.resolve() },
  };

  it('contributes tools based on global config', async () => {
    const config: WebPluginConfig = {
      providers: {
        tavily: { apiKey: 'tav-key' },
        jina: { apiKey: 'jina-key' },
      },
      search: 'tavily',
      fetch: 'jina',
    };
    const ctx: PluginContext<WebPluginConfig> = { config, capabilities: dummyCapabilities };
    await webPlugin.setup(ctx);

    const toolsFn = webPlugin.contributes?.tools;
    expect(typeof toolsFn).toBe('function');
    if (typeof toolsFn === 'function') {
      const tools = toolsFn('chat-1', { enabled: true }) ?? [];
      expect(tools.map(t => t.name)).toEqual(['web_search', 'web_fetch']);
    }
  });

  it('allows per-chat search provider override', async () => {
    const config: WebPluginConfig = {
      providers: {
        tavily: { apiKey: 'tav-key' },
        exa: { apiKey: 'exa-key' },
      },
      search: 'tavily',
    };
    const ctx: PluginContext<WebPluginConfig> = { config, capabilities: dummyCapabilities };
    await webPlugin.setup(ctx);

    const toolsFn = webPlugin.contributes?.tools;
    if (typeof toolsFn === 'function') {
      const tools = toolsFn('chat-1', { enabled: true, search: 'exa' }) ?? [];
      expect(tools.map(t => t.name)).toEqual(['web_search']);
    }
  });

  it('throws error when search provider apiKey is missing', async () => {
    const config: WebPluginConfig = {
      providers: {
        tavily: { apiKey: '' },
      },
      search: 'tavily',
    };
    const ctx: PluginContext<WebPluginConfig> = { config, capabilities: dummyCapabilities };
    await webPlugin.setup(ctx);

    const toolsFn = webPlugin.contributes?.tools;
    if (typeof toolsFn === 'function') {
      expect(() => toolsFn('chat-1', { enabled: true })).toThrow(/apiKey is required for web\.search/);
    }
  });

  it('returns empty list if search and fetch are not configured', async () => {
    const config: WebPluginConfig = {
      providers: {},
    };
    const ctx: PluginContext<WebPluginConfig> = { config, capabilities: dummyCapabilities };
    await webPlugin.setup(ctx);

    const toolsFn = webPlugin.contributes?.tools;
    if (typeof toolsFn === 'function') {
      const tools = toolsFn('chat-1', { enabled: true }) ?? [];
      expect(tools).toEqual([]);
    }
  });
});
