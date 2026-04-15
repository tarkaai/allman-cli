import { describe, it, expect } from "vitest";
import { parseAttachments, parseMessageRaw } from "@/linkedin/api/endpoints/messages.js";

// Helper for tests that don't need the included[] lookup (most attachment
// shapes carry their data inline; video is the main exception).
const EMPTY_INCLUDED = new Map<string, Record<string, unknown>>();

describe("parseAttachments: hostUrnData (shared post)", () => {
  // This is the shape LinkedIn sends when a user shares a feed post into a
  // messenger thread. Every alternative in the tagged union is `null` except
  // `hostUrnData`. Pre-fix, the parser picked the first key it saw ("file",
  // which was null) and classified the message as a file — causing the TUI
  // to show "📎 attachment" instead of "↺ shared post".
  const SHARED_POST_RC = {
    videoMeeting: null,
    conversationAdsMessageContent: null,
    repliedMessageContent: null,
    video: null,
    vectorImage: null,
    awayMessage: null,
    file: null,
    externalMedia: null,
    messageAdRenderContent: null,
    audio: null,
    forwardedMessageContent: null,
    hostUrnData: {
      type: "FEED_UPDATE",
      hostUrn: "urn:li:fsd_update:(urn:li:activity:7450188970220638208,MESSAGING_RESHARE,EMPTY,DEFAULT,false)",
    },
    unavailableContent: null,
  };

  it("classifies a hostUrnData FEED_UPDATE as post_share, not file", () => {
    const [a] = parseAttachments([SHARED_POST_RC], EMPTY_INCLUDED);
    expect(a?.type).toBe("post_share");
  });

  it("extracts a permalink from the activity URN", () => {
    const [a] = parseAttachments([SHARED_POST_RC], EMPTY_INCLUDED);
    expect(a?.url).toBe(
      "https://www.linkedin.com/feed/update/urn:li:activity:7450188970220638208/"
    );
  });

  it("preserves the raw renderContent for renderers that need more", () => {
    const [a] = parseAttachments([SHARED_POST_RC], EMPTY_INCLUDED);
    expect(a?.raw).toBe(SHARED_POST_RC);
  });
});

describe("parseAttachments: skips null union alternatives", () => {
  // The key regression: the tagged-union discriminator is non-null, not
  // presence. Previously the parser's for-loop used `!== undefined` which
  // matched `file: null` before reaching the real content key.
  it("does not pick `file: null` when a later key has the payload", () => {
    const rc = {
      file: null,
      vectorImage: {
        fileIdentifyingUrlPathSegment: "/image.jpg",
        width: 800,
        height: 600,
      },
    };
    const [a] = parseAttachments([rc], EMPTY_INCLUDED);
    expect(a?.type).toBe("image");
    expect(a?.width).toBe(800);
    expect(a?.height).toBe(600);
  });

  it("does not pick `video: null` when a later key has the payload", () => {
    const rc = {
      video: null,
      audio: null,
      voice: {
        url: "https://example.com/voice.mp3",
        duration: 12500,
      },
    };
    const [a] = parseAttachments([rc], EMPTY_INCLUDED);
    expect(a?.type).toBe("voice");
    expect(a?.durationMs).toBe(12500);
  });
});

describe("parseAttachments: plain-file attachment", () => {
  it("classifies a real file payload (non-null) as file with metadata", () => {
    const rc = {
      file: {
        url: "https://example.com/resume.pdf",
        name: "resume.pdf",
        mediaType: "application/pdf",
        byteSize: 123456,
      },
    };
    const [a] = parseAttachments([rc], EMPTY_INCLUDED);
    expect(a?.type).toBe("file");
    expect(a?.name).toBe("resume.pdf");
    expect(a?.mimeType).toBe("application/pdf");
    expect(a?.size).toBe(123456);
  });
});

describe("parseAttachments: forwarded and replied", () => {
  it("forwards message content with original sender name", () => {
    const rc = {
      forwardedMessageContent: {
        forwardedBody: "original text",
        originalSender: {
          participantType: {
            member: { firstName: { text: "Alice" }, lastName: { text: "Nguyen" } },
          },
        },
      },
    };
    const [a] = parseAttachments([rc], EMPTY_INCLUDED);
    expect(a?.type).toBe("forwarded");
    expect(a?.originalText).toBe("original text");
    expect(a?.authorName).toBe("Alice Nguyen");
  });

  it("reply attachments carry the replied-to snippet", () => {
    const rc = {
      repliedMessageContent: {
        messageBody: "the thing I'm replying to",
        originalSender: {
          participantType: {
            member: { firstName: { text: "Bob" }, lastName: { text: "Jones" } },
          },
        },
      },
    };
    const [a] = parseAttachments([rc], EMPTY_INCLUDED);
    expect(a?.type).toBe("replied");
    expect(a?.originalText).toBe("the thing I'm replying to");
    expect(a?.authorName).toBe("Bob Jones");
  });
});

describe("parseAttachments: external media (gif vs link_preview)", () => {
  it("image/gif mediaType → gif", () => {
    const rc = {
      externalMedia: {
        media: { url: "https://example.com/a.gif", mediaType: "image/gif" },
        title: "funny gif",
      },
    };
    const [a] = parseAttachments([rc], EMPTY_INCLUDED);
    expect(a?.type).toBe("gif");
  });

  it("non-gif external media → link_preview", () => {
    const rc = {
      externalMedia: {
        media: { url: "https://example.com/article", mediaType: "text/html" },
        title: "some article",
        description: "a blurb",
      },
    };
    const [a] = parseAttachments([rc], EMPTY_INCLUDED);
    expect(a?.type).toBe("link_preview");
    expect(a?.title).toBe("some article");
    expect(a?.description).toBe("a blurb");
  });
});

describe("parseAttachments: unavailable / away messages", () => {
  it("unavailable content", () => {
    const rc = { unavailableContent: { unavailableReason: "DELETED" } };
    const [a] = parseAttachments([rc], EMPTY_INCLUDED);
    expect(a?.type).toBe("unavailable");
    expect(a?.description).toBe("DELETED");
  });

  it("away message", () => {
    const rc = { awayMessage: { text: "Out until Monday", footerText: "Auto-reply" } };
    const [a] = parseAttachments([rc], EMPTY_INCLUDED);
    expect(a?.type).toBe("away_message");
    expect(a?.originalText).toBe("Out until Monday");
    expect(a?.description).toBe("Auto-reply");
  });
});

describe("parseAttachments: all-null renderContent (truly empty)", () => {
  it("returns type=other when every alternative is null", () => {
    const rc = {
      file: null,
      video: null,
      audio: null,
      vectorImage: null,
      externalMedia: null,
      hostUrnData: null,
    };
    const [a] = parseAttachments([rc], EMPTY_INCLUDED);
    expect(a?.type).toBe("other");
  });
});

describe("parseMessageRaw: timestamp fallback when deliveredAt is missing", () => {
  // The Brian Risk "sent a post" message had no deliveredAt. With a raw zero
  // timestamp, sync.ts's older-boundary check misclassified it as "older than
  // fromMs" and stopped the entire inbox sync. We now fall back to createdAt
  // / lastEditedAt / insertedAt so downstream logic has a real timestamp.
  it("uses createdAt when deliveredAt is absent", () => {
    const included = new Map<string, Record<string, unknown>>();
    included.set("m1", {
      backendUrn: "urn:li:messagingMessage:m1",
      createdAt: 1776263638640,
      body: { text: "hello" },
      renderContent: [],
    });
    const msg = parseMessageRaw("m1", included);
    expect(msg?.deliveredAt).toBe(1776263638640);
  });

  it("prefers deliveredAt over fallbacks when present", () => {
    const included = new Map<string, Record<string, unknown>>();
    included.set("m1", {
      backendUrn: "urn:li:messagingMessage:m1",
      deliveredAt: 2000,
      createdAt: 1000,
      body: { text: "hello" },
      renderContent: [],
    });
    const msg = parseMessageRaw("m1", included);
    expect(msg?.deliveredAt).toBe(2000);
  });

  it("falls through to insertedAt when deliveredAt and createdAt are both missing", () => {
    const included = new Map<string, Record<string, unknown>>();
    included.set("m1", {
      backendUrn: "urn:li:messagingMessage:m1",
      insertedAt: 500,
      body: { text: "hello" },
      renderContent: [],
    });
    const msg = parseMessageRaw("m1", included);
    expect(msg?.deliveredAt).toBe(500);
  });

  it("returns 0 only when no timestamp field is present at all", () => {
    const included = new Map<string, Record<string, unknown>>();
    included.set("m1", {
      backendUrn: "urn:li:messagingMessage:m1",
      body: { text: "hello" },
      renderContent: [],
    });
    const msg = parseMessageRaw("m1", included);
    expect(msg?.deliveredAt).toBe(0);
  });
});
