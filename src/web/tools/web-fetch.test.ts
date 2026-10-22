import { describe, expect, it } from 'vitest';

import { createWebFetchTool } from './web-fetch';

describe('web_fetch tool', () => {
  it('formats markdown page output with title and url', async () => {
    const tool = createWebFetchTool({
      fetch: () => Promise.resolve({
        title: 'Example Domain',
        url: 'https://example.com',
        content: 'This is example content.',
      }),
    });
    const { content, requiresFollowUp } = await tool.execute({ url: 'https://example.com' });
    expect(content).toBe('Title: Example Domain\nURL: https://example.com\n\nThis is example content.');
    expect(requiresFollowUp).toBe(true);
  });

  it('omits title header when backend provides no title', async () => {
    const tool = createWebFetchTool({
      fetch: () => Promise.resolve({
        url: 'https://example.com/no-title',
        content: 'No title content.',
      }),
    });
    const { content, requiresFollowUp } = await tool.execute({ url: 'https://example.com/no-title' });
    expect(content).toBe('URL: https://example.com/no-title\n\nNo title content.');
    expect(requiresFollowUp).toBe(true);
  });
});
