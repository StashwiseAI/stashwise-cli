// Runtime configuration — primarily the API base URL.
//
// Override locally with `STASHWISE_API_URL=http://127.0.0.1:8000/api/v1` so
// you can iterate on the MCP server against a local backend without
// republishing.

export interface CliConfig {
  apiBaseUrl: string;
  webBaseUrl: string;
}

const DEFAULT_API_URL = "https://stashwise-api.fly.dev/api/v1";
const DEFAULT_WEB_URL = "https://stashwise.co";

export function loadConfig(): CliConfig {
  const apiBaseUrl = (
    process.env.STASHWISE_API_URL ?? DEFAULT_API_URL
  ).replace(/\/$/, "");
  const webBaseUrl = (
    process.env.STASHWISE_WEB_URL ?? DEFAULT_WEB_URL
  ).replace(/\/$/, "");
  return { apiBaseUrl, webBaseUrl };
}
