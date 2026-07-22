// Typed HTTP client — one method per backend endpoint the MCP server / auth
// flow needs. Kept intentionally small; this is not a general SDK.

import type { CliConfig } from "./config.js";

export interface DeviceCodeStartResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
}

export interface DeviceCodePollResponse {
  status: "pending" | "authorized" | "expired";
  token?: string;
  user?: {
    id: string;
    email: string | null;
    display_name: string | null;
    subscription_tier: string;
  };
}

export interface AgentSearchResultItem {
  kind: "content" | "entity";
  id: string;
  title: string;
  snippet: string;
  source_url: string | null;
  source_platform: string | null;
  score: number;
  citation: string;
  saved_at: string | null;
}

export interface AgentSearchResponse {
  results: AgentSearchResultItem[];
  query: string;
  retrieval_ms: number;
}

export interface AgentRecentResponse {
  results: AgentSearchResultItem[];
  since: string;
  retrieval_ms: number;
}

export type AgentResultKind = "content" | "entity";

export interface AgentCategory {
  id: string;
  name: string;
  parent_id: string | null;
  path: string[];
  depth: number;
  child_count: number;
  content_count: number;
  subtree_content_count: number;
  description?: string | null;
  sort_order?: number;
}

export interface AgentCategoryListResponse {
  categories: AgentCategory[];
}

export interface AgentCategoryCreateResponse {
  created: boolean;
  category: AgentCategory;
}

export interface AgentItemMoveResponse {
  moved_count: number;
  content_ids: string[];
  category_id: string | null;
  path: string[];
}

export interface MeResponse {
  id: string;
  email: string | null;
  display_name: string | null;
  subscription_tier: string;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export class StashwiseApi {
  constructor(private readonly config: CliConfig) {}

  private async request<T>(
    path: string,
    init: RequestInit & { token?: string } = {},
  ): Promise<T> {
    const { token, headers, ...rest } = init;
    const res = await fetch(`${this.config.apiBaseUrl}${path}`, {
      ...rest,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(headers ?? {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ApiError(res.status, text || res.statusText);
    }
    if (res.status === 204) {
      return undefined as T;
    }
    return (await res.json()) as T;
  }

  startDeviceCode(clientLabel: string): Promise<DeviceCodeStartResponse> {
    return this.request<DeviceCodeStartResponse>("/auth/cli/start", {
      method: "POST",
      body: JSON.stringify({ client_label: clientLabel }),
    });
  }

  pollDeviceCode(deviceCode: string): Promise<DeviceCodePollResponse> {
    return this.request<DeviceCodePollResponse>("/auth/cli/poll", {
      method: "POST",
      body: JSON.stringify({ device_code: deviceCode }),
    });
  }

  search(
    token: string,
    query: string,
    k: number,
    scope: "library" | "wiki" | "all",
    signal?: AbortSignal,
  ): Promise<AgentSearchResponse> {
    return this.request<AgentSearchResponse>("/agent/search", {
      method: "POST",
      token,
      body: JSON.stringify({ query, k, scope }),
      signal,
    });
  }

  recent(
    token: string,
    days: number,
    k: number,
    scope: "library" | "wiki" | "all",
  ): Promise<AgentRecentResponse> {
    return this.request<AgentRecentResponse>("/agent/recent", {
      method: "POST",
      token,
      body: JSON.stringify({ days, k, scope }),
    });
  }

  getItem(token: string, contentId: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      `/agent/content/${encodeURIComponent(contentId)}`,
      { token },
    );
  }

  getContext(
    token: string,
    kind: AgentResultKind,
    resultId: string,
  ): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      `/agent/context/${kind}/${encodeURIComponent(resultId)}`,
      { token },
    );
  }

  listCategories(token: string): Promise<AgentCategoryListResponse> {
    return this.request<AgentCategoryListResponse>("/agent/categories", { token });
  }

  createFolder(
    token: string,
    name: string,
    parentId?: string | null,
  ): Promise<AgentCategoryCreateResponse> {
    return this.request<AgentCategoryCreateResponse>("/agent/categories", {
      method: "POST",
      token,
      body: JSON.stringify({ name, parent_id: parentId ?? null }),
    });
  }

  moveItems(
    token: string,
    contentIds: string[],
    categoryId: string | null,
  ): Promise<AgentItemMoveResponse> {
    return this.request<AgentItemMoveResponse>("/agent/items/move", {
      method: "POST",
      token,
      body: JSON.stringify({ content_ids: contentIds, category_id: categoryId }),
    });
  }

  me(token: string): Promise<MeResponse> {
    return this.request<MeResponse>("/auth/me", { token });
  }
}
