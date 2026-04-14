/**
 * Dump raw included[] entities from messengerMessagesByAnchorTimestamp
 * to see entityUrn vs backendUrn for a message.
 */

import { Store, resolveStorePath } from "../src/store/index.js";
import { loadSession } from "../src/linkedin/api/session.js";
import { extractBareConvId } from "../src/utils/urn.js";

async function main() {
  const slug = process.argv[2] ?? "jfoo87";

  const storePath = resolveStorePath();
  const store = new Store({ path: storePath });
  await store.init();
  const session = await loadSession(store);
  const { apiClient, profileId, myProfileUrn } = session;
  const conversations = store.forAccount(profileId);

  const convId = await conversations.resolve(slug);
  if (!convId) throw new Error(`no conv for slug ${slug}`);
  const conv = await conversations.read(convId);
  if (!conv) throw new Error(`no conv record`);

  const senderProfileId = myProfileUrn.replace("urn:li:fsd_profile:", "");
  const bareConvId = extractBareConvId(conv.backendUrn ?? conv.convUrn ?? convId);
  const encodedConvUrn = `urn%3Ali%3Amsg_conversation%3A%28urn%3Ali%3Afsd_profile%3A${senderProfileId}%2C${encodeURIComponent(bareConvId)}%29`;

  const variables = `(deliveredAt:${Date.now()},conversationUrn:${encodedConvUrn},countBefore:3,countAfter:0)`;

  const response = await apiClient.request<{ included?: Array<Record<string, unknown>> }>({
    method: "GET",
    url: `https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMessages.90abe2bc64df3bc3e1323a1479989b49&variables=${variables}`,
  });

  for (const item of response.included ?? []) {
    if (
      typeof item["$type"] === "string" &&
      (item["$type"] as string).includes("Message")
    ) {
      console.log(JSON.stringify({
        $type: item["$type"],
        entityUrn: item["entityUrn"],
        backendUrn: item["backendUrn"],
        body: (item["body"] as { text?: string } | undefined)?.text?.slice(0, 30),
        reactionSummaries: item["reactionSummaries"],
      }, null, 2));
    }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
