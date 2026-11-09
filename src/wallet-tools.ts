// The two paid MCP tools and `stashwise wallet recover`.
//
// Raw credentials stop here. A first contact response is the only place the
// server ever sends them, so they go straight to the keychain and the result
// the agent sees is rebuilt field by field without them.

import { z } from "zod";
import {
  ApiError,
  StashwiseApi,
  type X402Account,
  type X402SaveResponse,
} from "./api.js";
import { STASHWISE_WALLET_RECOVER_COMMAND } from "./commands.js";
import { loadConfig, type CliConfig } from "./config.js";
import { getWalletToken, storeWalletCredentials } from "./keychain.js";
import { loadWallet, type Wallet, type WalletState } from "./wallet.js";

export const SAVE_TOOL_NAME = "save_to_stashwise";
export const NOTE_TOOL_NAME = "create_stashwise_note";

const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  openWorldHint: false,
  destructiveHint: false,
} as const;

export const PAID_TOOL_DEFINITIONS = [
  {
    name: SAVE_TOOL_NAME,
    description:
      "Save a public URL to this wallet's own private Stashwise library. Spends USDC from the configured wallet, about $0.08 for a page and $0.30 for a video, within the caps set by the operator. A URL this wallet already saved is not charged again.",
    inputSchema: {
      type: "object",
      properties: {
        source_url: { type: "string", minLength: 1 },
        title: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        category_id: { type: "string" },
        personal_notes: { type: "string" },
      },
      required: ["source_url"],
    },
    annotations: WRITE_ANNOTATIONS,
  },
  {
    name: NOTE_TOOL_NAME,
    description:
      "Create a research note in this wallet's own private Stashwise library. Spends about $0.08 USDC from the configured wallet, within the caps set by the operator.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 500 },
        body: { type: "string", minLength: 1 },
        summary: { type: "string", maxLength: 4000 },
        tags: { type: "array", items: { type: "string" } },
        links: { type: "array", items: { type: "object" } },
        include_in_wiki: { type: "boolean", default: true },
      },
      required: ["title", "body"],
    },
    annotations: WRITE_ANNOTATIONS,
  },
];

const SaveInputSchema = z.object({
  source_url: z.string().min(1),
  title: z.string().optional(),
  tags: z.array(z.string()).optional(),
  category_id: z.string().optional(),
  personal_notes: z.string().optional(),
});

const NoteInputSchema = z.object({
  title: z.string().min(1).max(500),
  body: z.string().min(1),
  summary: z.string().max(4000).optional(),
  tags: z.array(z.string()).optional(),
  links: z.array(z.record(z.unknown())).optional(),
  include_in_wiki: z.boolean().optional(),
});

interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

function textResult(text: string, isError = false): ToolResult {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

export function isPaidTool(name: string): boolean {
  return name === SAVE_TOOL_NAME || name === NOTE_TOOL_NAME;
}

/** Keep the credentials, and report only whether that worked. */
async function persistCredentials(
  config: CliConfig,
  wallet: Wallet,
  account: X402Account | null,
): Promise<boolean> {
  if (!account?.agent_token) return true;
  try {
    await storeWalletCredentials(config.apiBaseUrl, wallet.address, {
      token: account.agent_token,
      claimCredential: account.claim?.credential ?? null,
    });
    return true;
  } catch {
    return false;
  }
}

/** What the agent sees. Built up from allowed fields, never by deleting secrets. */
function agentView(
  response: X402SaveResponse,
  stored: boolean,
): Record<string, unknown> {
  const account = response.account;
  const view: Record<string, unknown> = {
    content: response.content,
    payment: response.payment,
    credit: response.credit,
    account: account ? { user_id: account.user_id, created: account.created } : null,
  };
  if (account?.claim?.url) {
    view.claim_url = account.claim.url;
    view.claim_note =
      "This link is shown once. Give it to the person who should own this library, then do not repeat it.";
  }
  if (!stored) {
    view.credentials_warning = `This wallet's credentials could not be saved on this machine. Run \`${STASHWISE_WALLET_RECOVER_COMMAND}\` to issue new ones.`;
  }
  return view;
}

export async function callPaidTool(
  api: StashwiseApi,
  config: CliConfig,
  state: WalletState,
  name: string,
  args: unknown,
): Promise<ToolResult> {
  if (state.status === "absent") {
    return textResult(`Unknown tool: ${name}`, true);
  }
  if (state.status === "invalid") {
    return textResult(`Stashwise wallet is not usable: ${state.problem}`, true);
  }
  const wallet = state.wallet;
  const schema = name === SAVE_TOOL_NAME ? SaveInputSchema : NoteInputSchema;
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) {
    return textResult(
      `Invalid arguments: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      true,
    );
  }
  try {
    const token = await getWalletToken(config.apiBaseUrl, wallet.address);
    const response =
      name === SAVE_TOOL_NAME
        ? await api.paidSave(wallet, token, SaveInputSchema.parse(parsed.data))
        : await api.paidNote(wallet, token, NoteInputSchema.parse(parsed.data));
    const stored = await persistCredentials(config, wallet, response.account);
    return textResult(JSON.stringify(agentView(response, stored), null, 2));
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      return textResult(
        `Stashwise rejected this wallet's token. Run \`${STASHWISE_WALLET_RECOVER_COMMAND}\` to issue a new one.`,
        true,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return textResult(`Stashwise paid request failed: ${message}`, true);
  }
}

async function recover(wallet: Wallet): Promise<number> {
  const config = loadConfig();
  const api = new StashwiseApi(config);
  try {
    const challenge = await api.walletRecoveryChallenge();
    const proof = await wallet.proveControl(
      challenge,
      new URL(config.apiBaseUrl).host,
    );
    const { account } = await api.walletRecover(proof);
    const stored = await persistCredentials(config, wallet, account);
    // Recovery rotated the credential, so any earlier link is dead and this
    // is the only time the new one is shown, stored or not.
    if (account.claim?.url) {
      process.stdout.write(
        `Claim link, shown once. Give it to the person who should own this library, then do not repeat it:\n${account.claim.url}\n`,
      );
    }
    if (!stored) {
      process.stderr.write(
        "Recovered, but the new credentials could not be saved on this machine. The previous token no longer works, so run this again once the keychain is available.\n",
      );
      return 1;
    }
    process.stdout.write(
      `Recovered the Stashwise account for ${wallet.address}. A new token and claim credential are stored on this machine, and the previous ones no longer work.\n`,
    );
    return 0;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      process.stderr.write(
        "This wallet has no Stashwise account yet. Its first paid save creates one.\n",
      );
      return 1;
    }
    if (err instanceof ApiError && err.status === 401) {
      process.stderr.write("The server did not accept this wallet's proof.\n");
      return 1;
    }
    process.stderr.write(
      `Recovery failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

export async function runWallet(args: string[]): Promise<number> {
  if ((args[0] ?? "").toLowerCase() !== "recover") {
    process.stderr.write(`Usage: ${STASHWISE_WALLET_RECOVER_COMMAND}\n`);
    return 2;
  }
  const state = await loadWallet();
  if (state.status === "absent") {
    process.stderr.write(
      "No wallet is configured. Set STASHWISE_WALLET_PRIVATE_KEY first.\n",
    );
    return 2;
  }
  if (state.status === "invalid") {
    process.stderr.write(`${state.problem}\n`);
    return 2;
  }
  return recover(state.wallet);
}
