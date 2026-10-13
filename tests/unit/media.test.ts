import { describe, expect, it } from "vitest";
import { extensionFor } from "@/linkedin/api/endpoints/media.js";
import { parseAttachments } from "@/linkedin/api/endpoints/messages.js";

describe("extensionFor", () => {
  it("prefers the response content-type", () => {
    expect(extensionFor("image/jpeg; charset=binary", "application/pdf", "x.pdf")).toBe("jpg");
  });
  it("falls back to the attachment mime, then the file name, then bin", () => {
    expect(extensionFor(null, "application/pdf", null)).toBe("pdf");
    expect(extensionFor(null, null, "deck.PPTX")).toBe("pptx");
    expect(extensionFor("application/octet-stream", null, null)).toBe("bin");
  });
});

describe("messaging image parsing", () => {
  it("uses the tokenised rootUrl when artifacts are empty", () => {
    const renderContent = [
      {
        vectorImage: {
          rootUrl:
            "https://www.linkedin.com/dms/prv/image/v2/SYNTH/messaging-image-720/x/0/1?m=TOKEN&v=beta",
          artifacts: [],
        },
      },
    ];
    const parsed = parseAttachments(renderContent, new Map());
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.type).toBe("image");
    expect(parsed[0]?.url).toContain("messaging-image-720");
  });
});

import { urlFromRaw } from "@/commands/media.js";

describe("urlFromRaw", () => {
  it("reads a messaging image rootUrl, preferring the largest artifact when present", () => {
    expect(
      urlFromRaw({
        vectorImage: {
          rootUrl: "https://x/dms/prv/image/v2/A/messaging-image-720/0/1?m=T",
          artifacts: [],
        },
      })
    ).toContain("messaging-image-720");
    expect(
      urlFromRaw({
        vectorImage: {
          rootUrl: "https://x/root/",
          artifacts: [
            { width: 100, fileIdentifyingUrlPathSegment: "s/100" },
            { width: 800, fileIdentifyingUrlPathSegment: "s/800" },
          ],
        },
      })
    ).toBe("https://x/root/s/800");
  });
  it("reads file/audio/video urls and returns null otherwise", () => {
    expect(urlFromRaw({ file: { url: "https://x/f" } })).toBe("https://x/f");
    expect(urlFromRaw({ audio: { url: "https://x/a" } })).toBe("https://x/a");
    expect(urlFromRaw({ repliedMessageContent: {} })).toBeNull();
    expect(urlFromRaw(null)).toBeNull();
  });
});
