/**
 * Standalone probe for LinkedIn's message reaction endpoint.
 *
 * Based on decompiled messenger.js:
 *   POST /voyager/api/voyagerMessagingDashMessengerMessages?action=reactWithEmoji
 *   body: { messageUrn, emoji }
 *
 * Unreact uses action=unreactWithEmoji with the same body shape.
 *
 * Run:
 *   ALLMAN_STORE=$HOME/.allman \
 *     bun run scripts/test-react.ts <messageUrn> <emoji> [--unreact]
 */

import axios from "axios";
import { Store, resolveStorePath } from "../src/store/index.js";
import { loadSession } from "../src/linkedin/api/session.js";
import { buildCookieHeader, getCsrfToken } from "../src/linkedin/api/cookies.js";

async function main() {
  const [messageUrn, emoji, ...rest] = process.argv.slice(2);
  const unreact = rest.includes("--unreact");

  if (!messageUrn || !emoji) {
    console.error("Usage: test-react <messageUrn> <emoji> [--unreact]");
    process.exit(1);
  }

  const storePath = resolveStorePath();
  const store = new Store({ path: storePath });
  await store.init();

  const session = await loadSession(store);
  const { apiClient } = session;

  const action = unreact ? "unreactWithEmoji" : "reactWithEmoji";
  console.log(`→ ${action}`);
  console.log(`   messageUrn: ${messageUrn}`);
  console.log(`   emoji: ${emoji}`);

  // Use raw axios so we see the error body directly.
  const jar = apiClient.getJar();
  const cookie = await buildCookieHeader(jar);
  const csrfToken = (await getCsrfToken(jar)) ?? "";

  const headers: Record<string, string> = {
    cookie,
    "csrf-token": csrfToken,
    accept: "application/vnd.linkedin.normalized+json+2.1",
    "content-type": "application/json",
    "accept-language": "en-US,en;q=0.9",
    "x-li-lang": "en_US",
    "x-restli-protocol-version": "2.0.0",
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    referer: "https://www.linkedin.com/messaging/",
  };

  try {
    const res = await axios({
      method: "POST",
      url: "https://www.linkedin.com/voyager/api/voyagerMessagingDashMessengerMessages",
      params: { action },
      data: { messageUrn, emoji },
      headers,
      validateStatus: () => true,
    });
    console.log(`status: ${res.status}`);
    console.log("body:", JSON.stringify(res.data, null, 2));
  } catch (err) {
    console.error("✗ network error:", err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
