/**
 * Unit tests for the conversations parser.
 *
 * Shapes mirror live `messengerConversations` responses; all ids and names are
 * synthetic placeholders and do not correspond to any real LinkedIn account.
 *
 * Regression context: every field below was already declared on
 * `ConversationRecord` and hardcoded to null/false/[] by the writers, while the
 * API had been returning it all along.
 */
import { describe, expect, it } from "vitest";
import { parseConversationsResponse } from "@/linkedin/api/endpoints/conversations.js";

const ME = "urn:li:fsd_profile:ACoSYNTHME000000000000000000000000001";
const THEM = "urn:li:fsd_profile:ACoSYNTHTHEM00000000000000000000001";
const CONV = `urn:li:msg_conversation:(${ME},2-synthetic==)`;
const PART_ME = `urn:li:msg_messagingParticipant:${ME}`;
const PART_THEM = `urn:li:msg_messagingParticipant:${THEM}`;

function participant(opts: {
  urn: string;
  host: string;
  first: string;
  last: string;
  extra?: Record<string, unknown>;
  member?: Record<string, unknown>;
}) {
  return {
    $type: "com.linkedin.messenger.MessagingParticipant",
    entityUrn: opts.urn,
    backendUrn: `urn:li:msg_messagingParticipant:backend-${opts.first}`,
    hostIdentityUrn: opts.host,
    participantType: {
      member: {
        firstName: { text: opts.first },
        lastName: { text: opts.last },
        headline: { text: `${opts.first}'s headline` },
        profileUrl: `https://www.linkedin.com/in/${opts.host}`,
        ...opts.member,
      },
    },
    ...opts.extra,
  };
}

function response(
  conv: Record<string, unknown> = {},
  participants: Array<Record<string, unknown>> = []
) {
  return {
    data: { data: { messengerConversationsByCategoryQuery: { "*elements": [CONV] } } },
    included: [
      {
        $type: "com.linkedin.messenger.Conversation",
        entityUrn: CONV,
        backendUrn: "urn:li:messagingThread:2-synthetic==",
        groupChat: false,
        unreadCount: 0,
        lastActivityAt: 1786981522193,
        "*conversationParticipants": [PART_ME, PART_THEM],
        ...conv,
      },
      ...participants,
    ],
  };
}

describe("parseConversationsResponse — conversation state", () => {
  it("keeps createdAt, lastReadAt, categories, url, notification status and disabled features", () => {
    const [c] = parseConversationsResponse(
      response({
        createdAt: 1786981522159,
        lastReadAt: 1787000502682,
        read: true,
        notificationStatus: "MUTED",
        categories: ["INBOX", "PRIMARY_INBOX"],
        conversationUrl: "https://www.linkedin.com/messaging/thread/2-synthetic==/",
        disabledFeatures: [
          { disabledFeature: "ADD_PARTICIPANT", reasonText: null },
          { disabledFeature: "REMOVE_PARTICIPANT", reasonText: null },
          { reasonText: null },
        ],
      })
    );
    expect(c?.createdAt).toBe(1786981522159);
    expect(c?.lastReadAt).toBe(1787000502682);
    expect(c?.read).toBe(true);
    expect(c?.notificationStatus).toBe("MUTED");
    expect(c?.categories).toEqual(["INBOX", "PRIMARY_INBOX"]);
    expect(c?.conversationUrl).toBe("https://www.linkedin.com/messaging/thread/2-synthetic==/");
    // A disabled-feature entry with no name carries nothing usable.
    expect(c?.disabledFeatures).toEqual(["ADD_PARTICIPANT", "REMOVE_PARTICIPANT"]);
  });

  it("prefers LinkedIn's read flag over inferring it from unreadCount", () => {
    // The two disagree in practice: a thread can be marked read server-side
    // while still reporting a stale unread count.
    const [c] = parseConversationsResponse(response({ read: false, unreadCount: 0 }));
    expect(c?.read).toBe(false);
  });

  it("falls back to unreadCount === 0 when the read flag is absent", () => {
    expect(parseConversationsResponse(response({ unreadCount: 0 }))[0]?.read).toBe(true);
    expect(parseConversationsResponse(response({ unreadCount: 3 }))[0]?.read).toBe(false);
  });

  it("defaults the collections to empty rather than undefined", () => {
    const [c] = parseConversationsResponse(response());
    expect(c?.categories).toEqual([]);
    expect(c?.disabledFeatures).toEqual([]);
    expect(c?.createdAt).toBeNull();
    expect(c?.lastReadAt).toBeNull();
    expect(c?.notificationStatus).toBeNull();
    expect(c?.conversationUrl).toBeNull();
  });
});

describe("parseConversationsResponse — participants", () => {
  it("keeps distance, pronoun, badge, premium/verified flags and every avatar size", () => {
    const [c] = parseConversationsResponse(
      response({}, [
        participant({
          urn: PART_THEM,
          host: THEM,
          first: "Alpha",
          last: "Tester",
          extra: { memberBadgeType: "PREMIUM_PROFILE", showPremiumInBug: true },
          member: {
            distance: "DISTANCE_1",
            pronoun: { standardizedPronoun: "SHE_HER", customPronoun: null },
            profilePicture: {
              rootUrl: "https://media.example/photo-shrink_",
              artifacts: [
                { width: 400, height: 400, fileIdentifyingUrlPathSegment: "400_400/c.jpg" },
                { width: 100, height: 100, fileIdentifyingUrlPathSegment: "100_100/a.jpg" },
                { width: 200, height: 200, fileIdentifyingUrlPathSegment: "200_200/b.jpg" },
              ],
            },
          },
        }),
      ])
    );
    const p = c?.participants[0];
    expect(p?.entityUrn).toBe(THEM);
    expect(p?.distance).toBe("DISTANCE_1");
    expect(p?.pronoun).toBe("SHE_HER");
    expect(p?.memberBadgeType).toBe("PREMIUM_PROFILE");
    expect(p?.isPremium).toBe(true);
    expect(p?.isVerified).toBe(false);
    expect(p?.backendUrn).toBe("urn:li:msg_messagingParticipant:backend-Alpha");
    // Smallest first — `imageUrl` keeps its historical "smallest" meaning.
    expect(p?.profilePictures.map((x) => x.width)).toEqual([100, 200, 400]);
    expect(p?.imageUrl).toBe("https://media.example/photo-shrink_100_100/a.jpg");
  });

  it("derives isVerified from the verification badge", () => {
    const [c] = parseConversationsResponse(
      response({}, [
        participant({
          urn: PART_THEM,
          host: THEM,
          first: "Bravo",
          last: "Tester",
          extra: { memberBadgeType: "VERIFIED_PROFILE", showVerificationBadge: true },
        }),
      ])
    );
    expect(c?.participants[0]?.isVerified).toBe(true);
    expect(c?.participants[0]?.isPremium).toBe(false);
  });

  it("leaves the new participant fields empty when LinkedIn omits them", () => {
    const [c] = parseConversationsResponse(
      response({}, [participant({ urn: PART_ME, host: ME, first: "Solo", last: "Tester" })])
    );
    const p = c?.participants[0];
    expect(p?.distance).toBeNull();
    expect(p?.pronoun).toBeNull();
    expect(p?.memberBadgeType).toBeNull();
    expect(p?.isPremium).toBe(false);
    expect(p?.isVerified).toBe(false);
    expect(p?.profilePictures).toEqual([]);
    expect(p?.imageUrl).toBeNull();
  });
});
