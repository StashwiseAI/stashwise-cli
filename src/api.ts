// Typed HTTP client — one method per backend endpoint the MCP server / auth
// flow needs. Kept intentionally small; this is not a general SDK.

import type { CliConfig } from "./config.js";
import {
  PaymentOutcomeUnknownError,
  PaymentRefusedError,
  type PreparedPayment,
  type SiwxChallenge,
  type Wallet,
} from "./wallet.js";

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

const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
// A duplicate of something this wallet already saved is answered 200, uncharged.
const DUPLICATE_NOT_CHARGED = 200;
// Refusals the server makes before any settlement can have happened. A 5xx is
// deliberately absent: it says nothing about whether the transfer landed.
const NOT_CHARGED_STATUSES = new Set([400, 401, 402, 403, 404, 409, 413, 422, 429]);

export interface X402SaveBody {
  source_url: string;
  title?: string;
  tags?: string[];
  category_id?: string;
  personal_notes?: string;
}

export interface X402NoteBody {
  title: string;
  body: string;
  summary?: string;
  tags?: string[];
  links?: Record<string, unknown>[];
  include_in_wiki?: boolean;
}

export interface X402Account {
  user_id: string;
  created: boolean;
  agent_token: string | null;
  claim: { credential: string; url: string } | null;
}

export interface X402SaveResponse {
  content: Record<string, unknown> | null;
  payment: Record<string, unknown> | null;
  credit: Record<string, unknown> | null;
  account: X402Account | null;
}

export interface X402RecoverResponse {
  account: X402Account;
  payment: Record<string, unknown> | null;
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
    init: RequestInit & { token?: string; payer?: Wallet } = {},
  ): Promise<T> {
    const { token, headers, payer, ...rest } = init;
    const send = (extra: Record<string, string> = {}) =>
      fetch(`${this.config.apiBaseUrl}${path}`, {
        ...rest,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(headers ?? {}),
          ...extra,
        },
      });
    let res = await send();
    const challenge = res.status === 402 && payer
      ? res.headers.get(PAYMENT_REQUIRED_HEADER)
      : null;
    if (challenge && payer) {
      res = await this.payAndRetry(send, await payer.prepare(challenge));
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ApiError(res.status, text || res.statusText);
    }
    if (res.status === 204) {
      return undefined as T;
    }
    return (await res.json()) as T;
  }

  /**
   * The one paid retry. From here on money may move, so the amount stays
   * counted against today's cap unless the answer proves it was not charged.
   */
  private async payAndRetry(
    send: (extra: Record<string, string>) => Promise<Response>,
    payment: PreparedPayment,
  ): Promise<Response> {
    let res: Response;
    try {
      res = await send({ [PAYMENT_SIGNATURE_HEADER]: payment.header });
    } catch {
      throw new PaymentOutcomeUnknownError(payment.identifier);
    }
    if (res.status === DUPLICATE_NOT_CHARGED || NOT_CHARGED_STATUSES.has(res.status)) {
      // Losing this only leaves the cap stricter than it needs to be.
      await payment.release().catch(() => undefined);
    }
    if (res.status === 402) {
      const refused = (await res.json().catch(() => ({}))) as { error?: string };
      throw new PaymentRefusedError(
        `The server refused the payment: ${refused.error ?? "no reason given"}`,
      );
    }
    if (res.status >= 500) {
      throw new PaymentOutcomeUnknownError(payment.identifier);
    }
    return res;
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

  /** Save a URL as a paid save. The token, when there is one, unlocks credits. */
  paidSave(
    payer: Wallet,
    token: string | null,
    body: X402SaveBody,
  ): Promise<X402SaveResponse> {
    return this.request<X402SaveResponse>("/x402/saves", {
      method: "POST",
      token: token ?? undefined,
      payer,
      body: JSON.stringify(body),
    });
  }

  paidNote(
    payer: Wallet,
    token: string | null,
    body: X402NoteBody,
  ): Promise<X402SaveResponse> {
    return this.request<X402SaveResponse>("/x402/notes", {
      method: "POST",
      token: token ?? undefined,
      payer,
      body: JSON.stringify(body),
    });
  }

  /** Ask for a recovery challenge. The server answers 402 with no payment terms. */
  async walletRecoveryChallenge(): Promise<SiwxChallenge> {
    const res = await fetch(`${this.config.apiBaseUrl}/x402/account/recover`, {
      method: "POST",
    });
    const body = (await res.json().catch(() => ({}))) as {
      extensions?: Record<string, SiwxChallenge>;
    };
    const challenge = body.extensions?.["sign-in-with-x"];
    if (res.status !== 402 || !challenge) {
      throw new ApiError(res.status, "The server did not offer a recovery challenge.");
    }
    return challenge;
  }

  walletRecover(proof: string): Promise<X402RecoverResponse> {
    return this.request<X402RecoverResponse>("/x402/account/recover", {
      method: "POST",
      headers: { "SIGN-IN-WITH-X": proof },
    });
  }

  me(token: string): Promise<MeResponse> {
    return this.request<MeResponse>("/auth/me", { token });
  }
}
