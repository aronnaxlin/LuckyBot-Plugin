import { describe, expect, it } from 'vitest';

import { createWebSearchTool } from './web-search';

describe('web_search tool', () => {
  it('explains that an empty result is not evidence of absence', async () => {
    const tool = createWebSearchTool({ search: () => Promise.resolve({ results: [] }) });
    const { content, requiresFollowUp } = await tool.execute({ query: 'q' });
    const parsed = JSON.parse(content) as { results: unknown[]; note?: string };
    expect(parsed.results).toEqual([]);
    expect(parsed.note).toMatch(/not evidence/);
    expect(requiresFollowUp).toBe(true);
  });

  it('adds no note when there are results', async () => {
    const tool = createWebSearchTool({ search: () => Promise.resolve({ results: [{ title: 'T', url: 'https://x', snippet: 's' }] }) });
    const { content, requiresFollowUp } = await tool.execute({ query: 'q' });
    expect(JSON.parse(content)).toEqual({ results: [{ title: 'T', url: 'https://x', snippet: 's' }] });
    expect(requiresFollowUp).toBe(true);
  });
});
