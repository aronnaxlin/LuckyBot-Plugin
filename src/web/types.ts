import * as v from 'valibot';

export class HttpError extends Error {
  constructor(public readonly status: number, url: string) {
    super(`HTTP ${status}: ${url}`);
    this.name = 'HttpError';
  }
}

export type WebSearchProvider = 'tavily' | 'microsoft-grounding' | 'jina' | 'exa';
export type WebFetchProvider = 'jina';

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
  pageAge?: string;
}

export interface WebSearchResult {
  results: WebSearchResultItem[];
}

export interface WebSearcher {
  search: (query: string) => Promise<WebSearchResult>;
}

export interface WebFetchResult {
  title?: string;
  url: string;
  content: string;
}

export interface WebFetcher {
  fetch: (url: string) => Promise<WebFetchResult>;
}

export interface WebSearchConfig {
  provider: WebSearchProvider;
  apiKey: string;
}

export interface WebFetchConfig {
  provider: WebFetchProvider;
  jina: { apiKey: string };
}

export const WebConfigSchema = v.object({
  providers: v.optional(v.partial(v.object({
    tavily: v.partial(v.object({ apiKey: v.string() })),
    microsoftGrounding: v.partial(v.object({ apiKey: v.string() })),
    jina: v.partial(v.object({ apiKey: v.string() })),
    exa: v.partial(v.object({ apiKey: v.string() })),
  })), {}),
  search: v.optional(v.picklist(['tavily', 'microsoft-grounding', 'jina', 'exa'])),
  fetch: v.optional(v.picklist(['jina'])),
});

export type WebPluginConfig = v.InferOutput<typeof WebConfigSchema>;

export interface WebChatConfig {
  enabled?: boolean;
  search?: WebSearchProvider;
  fetch?: WebFetchProvider;
}
