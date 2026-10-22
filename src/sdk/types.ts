export const CURRENT_SDK_VERSION = 1;

export interface PluginLogger {
  log(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
  withFields(fields: Record<string, unknown>): PluginLogger;
  withError(error: unknown): PluginLogger;
}

export interface HttpRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
  body: unknown;
  params?: Record<string, string>;
}

export interface HttpResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string | Buffer | Record<string, unknown>;
}

export type HttpHandler = (req: HttpRequest) => Promise<HttpResponse | void> | HttpResponse | void;

export interface HttpRoute {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | '*';
  path: string;
  handler: HttpHandler;
}

export interface ChatPublishOptions {
  kind?: string;
  text: string;
  wake?: boolean;
}

export interface PromptHint {
  placement: 'system' | 'lateBinding';
  text: string;
}

export interface PluginExtensionPoints {
  tools?: unknown[];
  memoryBackend?: unknown;
  mediaResolvers?: unknown[];
  httpRoutes?: HttpRoute[];
  scenes?: unknown[];
  promptHints?: (chatId: string) => PromptHint[] | undefined;
}

export interface PluginCapabilities {
  callModel(
    modelName: string,
    prompt: string | { system?: string; user: string },
    options?: { timeoutSec?: number; dumpId?: string },
  ): Promise<string>;

  http: {
    route(route: HttpRoute): void;
  };

  chat: {
    publish(chatId: string, options: ChatPublishOptions): Promise<void> | void;
  };

  storage: {
    rootDir: string;
  };

  log: PluginLogger;

  media: {
    send(chatId: string, media: { kind: 'image' | 'audio'; [key: string]: unknown }): Promise<void>;
  };
}

export interface PluginContext<TConfig = unknown> {
  config: TConfig;
  capabilities: PluginCapabilities;
}

export interface PluginDefinition<TConfig = unknown> {
  id: string;
  sdkVersion: number;
  configSchema?: unknown;
  contributes?: PluginExtensionPoints;
  setup(ctx: PluginContext<TConfig>): Promise<void> | void;
  stop?(): Promise<void> | void;
}

export const definePlugin = <TConfig = unknown>(
  def: PluginDefinition<TConfig>,
): PluginDefinition<TConfig> => def;
