import { RuntimeBootstrapPayload } from "./runtime-types";

function trimTrailingSlash(value: string) {
  return value.replace(/\/$/, "");
}

export function getApiBaseUrl() {
  const value = process.env.API_BASE_URL;

  if (!value) {
    throw new Error("Missing API_BASE_URL.");
  }

  return trimTrailingSlash(value);
}

export function deriveWebSocketUrl(apiBaseUrl: string) {
  if (apiBaseUrl.startsWith("https://")) {
    return `${apiBaseUrl.replace("https://", "wss://")}/ws`;
  }

  if (apiBaseUrl.startsWith("http://")) {
    return `${apiBaseUrl.replace("http://", "ws://")}/ws`;
  }

  throw new Error(`Unsupported API_BASE_URL protocol in ${apiBaseUrl}`);
}

export async function fetchRuntimeBootstrap() {
  const apiBaseUrl = getApiBaseUrl();
  const response = await fetch(`${apiBaseUrl}/api/runtime/bootstrap`, {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Runtime bootstrap failed with status ${response.status}`);
  }

  const payload = (await response.json()) as {
    ok: boolean;
    payload: RuntimeBootstrapPayload;
  };

  if (!payload.ok) {
    throw new Error("Runtime bootstrap returned ok=false");
  }

  return {
    bootstrap: payload.payload,
    apiBaseUrl,
    websocketUrl: deriveWebSocketUrl(apiBaseUrl),
  };
}
