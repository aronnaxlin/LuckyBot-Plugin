import type { PluginTool } from '../../sdk/types';
import type { WebFetcher } from '../types';

export const createWebFetchTool = (fetcher: WebFetcher): PluginTool => ({
  name: 'web_fetch',
  description: 'Fetch a web page by URL and return its content as clean, readable Markdown. Use this to read articles, docs, or any page the conversation references.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The full URL of the page to fetch (including https://).' },
    },
    required: ['url'],
  },
  execute: async input => {
    const { url } = input as { url: string };
    const result = await fetcher.fetch(url);
    const header = [
      result.title ? `Title: ${result.title}` : undefined,
      `URL: ${result.url}`,
    ].filter(Boolean).join('\n');
    return { content: `${header}\n\n${result.content}`, requiresFollowUp: true };
  },
});
