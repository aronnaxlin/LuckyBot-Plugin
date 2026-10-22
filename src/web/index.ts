import { createWebFetcher } from './fetch';
import { createWebSearcher } from './search';
import { createWebFetchTool } from './tools/web-fetch';
import { createWebSearchTool } from './tools/web-search';
import {
  WebConfigSchema,
  type WebChatConfig,
  type WebPluginConfig,
  type WebSearchProvider,
} from './types';
import { CURRENT_SDK_VERSION, definePlugin, type PluginTool } from '../sdk';

export { WebConfigSchema, type WebChatConfig, type WebPluginConfig } from './types';

let activeGlobalConfig: WebPluginConfig | undefined;

export const webPlugin = definePlugin<WebPluginConfig>({
  id: 'web',
  sdkVersion: CURRENT_SDK_VERSION,
  configSchema: WebConfigSchema,
  contributes: {
    tools: (chatId: string, chatPluginConfig?: unknown): PluginTool[] => {
      const globalConfig = activeGlobalConfig;
      if (!globalConfig) return [];

      const perChat = chatPluginConfig as WebChatConfig | undefined;
      const searchProvider = perChat?.search ?? globalConfig.search;
      const fetchProvider = perChat?.fetch ?? globalConfig.fetch;

      const tools: PluginTool[] = [];

      if (searchProvider) {
        const providers = globalConfig.providers ?? {};
        let apiKey: string | undefined;
        let providerKey: string = searchProvider;

        if (searchProvider === 'tavily') {
          apiKey = providers.tavily?.apiKey;
        } else if (searchProvider === 'microsoft-grounding') {
          apiKey = providers.microsoftGrounding?.apiKey;
          providerKey = 'microsoftGrounding';
        } else if (searchProvider === 'jina') {
          apiKey = providers.jina?.apiKey;
        } else if (searchProvider === 'exa') {
          apiKey = providers.exa?.apiKey;
        }

        if (!apiKey) {
          throw new Error(
            `Chat ${chatId}: plugins.web.providers.${providerKey}.apiKey is required for web.search="${searchProvider}".`,
          );
        }

        const searcher = createWebSearcher({
          provider: searchProvider as WebSearchProvider,
          apiKey,
        });
        tools.push(createWebSearchTool(searcher));
      }

      if (fetchProvider === 'jina') {
        const apiKey = globalConfig.providers?.jina?.apiKey ?? '';
        const fetcher = createWebFetcher({
          provider: 'jina',
          jina: { apiKey },
        });
        tools.push(createWebFetchTool(fetcher));
      }

      return tools;
    },
  },
  setup(ctx) {
    activeGlobalConfig = ctx.config;
  },
  stop() {
    activeGlobalConfig = undefined;
  },
});
