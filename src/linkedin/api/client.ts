/**
 * LinkedIn Voyager API client.
 *
 * Handles:
 *   - Constructing the full set of LinkedIn-required headers
 *   - Cookie injection and post-response cookie merging
 *   - HTTP proxy support via tunnel
 *   - 401/403/429 error detection
 *   - Persisting updated cookies back to the store after each response
 *
 * Reference:
 *   monorepo/lib/services/.../linkedin-api-services.ts
 *   lilac/api/src/services/api/linkedin-api-client.ts
 */

import axios, { type AxiosRequestConfig, type AxiosResponse } from "axios";
import type tunnel from "tunnel";
import { CookieJar } from "tough-cookie";
import {
  buildCookieHeader,
  getCsrfToken,
  mergeCookies,
  loadCookieJar,
  newCookieJar,
} from "./cookies.js";
import type { AccountRecord, ProxyConfig } from "../../store/types.js";
import * as output from "../../utils/output.js";

// ---------------------------------------------------------------------------
// LinkedIn standard headers
// Pulled from: https://github.com/beeper/linkedin (originally)
// Verified against: monorepo/lib/services/.../linkedin-api-services.ts
// ---------------------------------------------------------------------------

const LI_TRACK = JSON.stringify({
  clientVersion: "1.13.8751",
  mpVersion: "1.13.8751",
  osName: "web",
  timezoneOffset: -5,
  timezone: "America/New York",
  deviceFormFactor: "DESKTOP",
  mpName: "voyager-web",
  displayDensity: 1,
  displayWidth: 2560,
  displayHeight: 1440,
});

const LI_RECIPE_MAP = JSON.stringify({
  inAppAlertsTopic:
    "com.linkedin.voyager.dash.deco.identity.notifications.InAppAlert-51",
  professionalEventsTopic:
    "com.linkedin.voyager.dash.deco.events.ProfessionalEventDetailPage-53",
  topCardLiveVideoTopic:
    "com.linkedin.voyager.dash.deco.video.TopCardLiveVideo-9",
});

const FALLBACK_HEADERS = {
  "accept-language": "en-US,en;q=0.9",
  "x-li-lang": "en_US",
  "x-restli-protocol-version": "2.0.0",
  "x-li-track": LI_TRACK,
  "x-li-recipe-accept": "application/vnd.linkedin.normalized+json+2.1",
  "x-li-recipe-map": LI_RECIPE_MAP,
  "x-li-page-instance":
    "urn:li:page:feed_index_index;bcfe9fd6-239a-49e9-af15-44b7e5895eaa",
  authority: "www.linkedin.com",
  referer: "https://www.linkedin.com/feed/",
  accept: "application/vnd.linkedin.normalized+json+2.1",
  "content-type": "application/json",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "sec-ch-ua": '"Not_A Brand";v="8", "Chromium";v="120"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Linux"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
};

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class LinkedInError extends Error {
  constructor(
    message: string,
    public readonly code: LinkedInErrorCode,
    public readonly statusCode?: number
  ) {
    super(message);
    this.name = "LinkedInError";
  }
}

export type LinkedInErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "NOT_CONNECTED"
  | "MESSAGING_BLOCKED"
  | "PREMIUM_REQUIRED"
  | "SERVER_ERROR"
  | "NETWORK_ERROR"
  | "UNKNOWN";

// ---------------------------------------------------------------------------
// Cookie persistence callback
// ---------------------------------------------------------------------------

export type CookiePersistFn = (updatedJar: CookieJar) => Promise<void>;

// ---------------------------------------------------------------------------
// API Client
// ---------------------------------------------------------------------------

export interface ApiClientOptions {
  /** Account record for cookie loading. */
  account: AccountRecord;
  /** Called after every response to persist updated cookies. */
  onCookieUpdate?: CookiePersistFn;
  /** Proxy configuration (from account config). */
  proxy?: ProxyConfig;
}

export interface ApiRequestOptions {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  url: string;
  params?: Record<string, string>;
  data?: unknown;
  /** Additional headers merged over the defaults. */
  headers?: Record<string, string>;
  /** For SSE stream responses. */
  responseType?: "json" | "stream";
  /** Timeout in ms. 0 = no timeout. */
  timeout?: number;
}

export class LinkedInApiClient {
  private jar: CookieJar;
  private readonly onCookieUpdate?: CookiePersistFn;
  private readonly proxy?: ProxyConfig;

  constructor(options: ApiClientOptions) {
    this.jar = loadCookieJar(options.account);
    this.onCookieUpdate = options.onCookieUpdate;
    this.proxy = options.proxy;
  }

  /** Replace the internal cookie jar (e.g. after login). */
  updateJar(jar: CookieJar): void {
    this.jar = jar;
  }

  /** Return a copy of the current cookie jar (for inspection). */
  getJar(): CookieJar {
    return this.jar;
  }

  async request<T = unknown>(options: ApiRequestOptions): Promise<T> {
    const cookieHeader = await buildCookieHeader(this.jar);
    const csrfToken = (await getCsrfToken(this.jar)) ?? "";

    const headers: Record<string, string> = {
      ...FALLBACK_HEADERS,
      cookie: cookieHeader,
      "csrf-token": csrfToken,
      ...options.headers,
    };

    const axiosConfig: AxiosRequestConfig = {
      method: options.method,
      url: options.url,
      headers,
      params: options.params,
      data: options.data,
      responseType: options.responseType ?? "json",
      timeout: options.timeout ?? 30_000,
      // Prevent axios from following redirects automatically (detect LinkedIn's
      // login redirect when cookies expire)
      maxRedirects: 0,
      validateStatus: (status) => status < 400,
    };

    if (this.proxy) {
      const tunnelLib = (await import("tunnel")).default;
      axiosConfig.httpsAgent = tunnelLib.httpsOverHttp({
        proxy: {
          host: this.proxy.host,
          port: this.proxy.port,
          ...(this.proxy.username && this.proxy.password
            ? { proxyAuth: `${this.proxy.username}:${this.proxy.password}` }
            : {}),
        },
        rejectUnauthorized: false,
      } as tunnel.HttpsOverHttpOptions);
    }

    let response: AxiosResponse;
    try {
      response = await axios(axiosConfig);
    } catch (err: unknown) {
      const axiosErr = err as {
        response?: AxiosResponse;
        code?: string;
        message?: string;
      };
      if (axiosErr.response) {
        response = axiosErr.response;
      } else {
        throw new LinkedInError(
          `Network error: ${axiosErr.message ?? "unknown"}`,
          "NETWORK_ERROR"
        );
      }
    }

    // Handle error status codes
    if (response.status >= 400) {
      this.handleErrorResponse(response);
    }

    // Merge Set-Cookie headers into jar and persist
    const setCookieHeaders = this.extractSetCookieHeaders(response);
    if (setCookieHeaders.length > 0) {
      await mergeCookies(this.jar, setCookieHeaders);
      if (this.onCookieUpdate) {
        await this.onCookieUpdate(this.jar);
      }
    }

    output.debug(`${options.method} ${options.url} → ${response.status}`);

    return response.data as T;
  }

  private handleErrorResponse(response: AxiosResponse): never {
    const status = response.status;

    if (status === 401 || status === 302) {
      throw new LinkedInError(
        "LinkedIn session expired. Run `lilac login` to re-authenticate.",
        "UNAUTHENTICATED",
        status
      );
    }

    if (status === 403) {
      // Check if it's a messaging restriction
      const body = JSON.stringify(response.data ?? "");
      if (body.includes("NOT_CONNECTED")) {
        throw new LinkedInError(
          "You are not connected with this person on LinkedIn.",
          "NOT_CONNECTED",
          403
        );
      }
      if (body.includes("MESSAGING_BLOCKED")) {
        throw new LinkedInError(
          "This person has restricted who can message them.",
          "MESSAGING_BLOCKED",
          403
        );
      }
      if (body.includes("PREMIUM") || body.includes("INMAIL")) {
        throw new LinkedInError(
          "Sending to this person requires LinkedIn Premium (InMail).",
          "PREMIUM_REQUIRED",
          403
        );
      }
      throw new LinkedInError("Access forbidden (403).", "FORBIDDEN", 403);
    }

    if (status === 429) {
      throw new LinkedInError(
        "LinkedIn rate limit hit. Wait 60s before retrying.",
        "RATE_LIMITED",
        429
      );
    }

    throw new LinkedInError(
      `LinkedIn API error: HTTP ${status}`,
      "UNKNOWN",
      status
    );
  }

  private extractSetCookieHeaders(response: AxiosResponse): string[] {
    const raw = response.headers["set-cookie"];
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    return [raw];
  }
}

/**
 * Build an API client for an account, with automatic cookie persistence.
 * The `persistCookies` callback is called whenever cookies are updated.
 */
export function buildApiClient(
  account: AccountRecord,
  persistCookies: CookiePersistFn,
  proxy?: ProxyConfig
): LinkedInApiClient {
  return new LinkedInApiClient({
    account,
    onCookieUpdate: persistCookies,
    proxy,
  });
}

/** Build an empty API client with no account (for testing). */
export function buildEmptyApiClient(): LinkedInApiClient {
  return new LinkedInApiClient({
    account: {
      urn: null,
      name: null,
      headline: null,
      profileUrl: null,
      imageUrl: null,
      userType: null,
      networkSize: null,
      status: "unauthenticated",
      cookieJar: null,
      cookiesUpdatedAt: null,
      lastSyncAt: null,
    },
  });
}

export { newCookieJar };
