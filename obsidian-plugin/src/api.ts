import { requestUrl } from "obsidian";
import type {
  DeviceCodePollResponse,
  DeviceCodeStartResponse,
  LearnGeneratorContextResponse,
  LearnSyncGuideDetailResponse,
  LearnSyncManifestResponse,
  MeResponse,
  WikiGraphResponse,
  WikiPageDetailResponse,
  WikiPagesListResponse,
} from "./types";

type HttpMethod = "GET" | "POST";

export class StashwiseApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "StashwiseApiError";
  }
}

export class StashwiseApi {
  constructor(
    private readonly apiBaseUrl: string,
    private readonly token: string,
  ) {}

  withToken(token: string): StashwiseApi {
    return new StashwiseApi(this.apiBaseUrl, token);
  }

  withBaseUrl(apiBaseUrl: string): StashwiseApi {
    return new StashwiseApi(apiBaseUrl, this.token);
  }

  startDeviceCode(clientLabel: string): Promise<DeviceCodeStartResponse> {
    return this.request<DeviceCodeStartResponse>("/auth/cli/start", {
      method: "POST",
      body: { client_label: clientLabel },
      authenticated: false,
    });
  }

  pollDeviceCode(deviceCode: string): Promise<DeviceCodePollResponse> {
    return this.request<DeviceCodePollResponse>("/auth/cli/poll", {
      method: "POST",
      body: { device_code: deviceCode },
      authenticated: false,
    });
  }

  me(): Promise<MeResponse> {
    return this.request<MeResponse>("/auth/me");
  }

  listWikiPages(skip: number, limit: number): Promise<WikiPagesListResponse> {
    return this.request<WikiPagesListResponse>("/wiki/pages", {
      query: {
        quality: "published",
        sort: "updated",
        skip: String(skip),
        limit: String(limit),
      },
    });
  }

  getWikiPage(entityId: string): Promise<WikiPageDetailResponse> {
    return this.request<WikiPageDetailResponse>(`/wiki/pages/${encodeURIComponent(entityId)}`);
  }

  getWikiGraph(): Promise<WikiGraphResponse> {
    return this.request<WikiGraphResponse>("/wiki/graph", {
      query: { quality: "published" },
    });
  }

  listLearnSyncManifest(skip: number, limit: number): Promise<LearnSyncManifestResponse> {
    return this.request<LearnSyncManifestResponse>("/use/learn/sync/manifest", {
      query: {
        skip: String(skip),
        limit: String(limit),
      },
    });
  }

  getLearnSyncGuide(guideId: string): Promise<LearnSyncGuideDetailResponse> {
    return this.request<LearnSyncGuideDetailResponse>(
      `/use/learn/sync/guides/${encodeURIComponent(guideId)}`,
    );
  }

  getLearnGeneratorContext(): Promise<LearnGeneratorContextResponse> {
    return this.request<LearnGeneratorContextResponse>("/use/learn/generator/context");
  }

  private async request<T>(
    path: string,
    options: {
      method?: HttpMethod;
      query?: Record<string, string>;
      body?: unknown;
      authenticated?: boolean;
    } = {},
  ): Promise<T> {
    const authenticated = options.authenticated ?? true;
    const url = this.buildUrl(path, options.query);
    const response = await requestUrl({
      url,
      method: options.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        ...(authenticated && this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    if (response.status < 200 || response.status >= 300) {
      throw new StashwiseApiError(response.status, response.text || `HTTP ${response.status}`);
    }

    return response.json as T;
  }

  private buildUrl(path: string, query?: Record<string, string>): string {
    const base = this.apiBaseUrl.replace(/\/+$/, "");
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(`${base}${normalizedPath}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }
}
