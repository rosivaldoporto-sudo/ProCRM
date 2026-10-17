import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendMediaMessage, uploadMediaToMeta } from "./meta-api";

// Capture the JSON body each helper POSTs to Meta so we can assert the
// exact payload shape per media kind without hitting the network.
interface CapturedBody {
  type?: string;
  image?: Record<string, unknown>;
  video?: Record<string, unknown>;
  document?: Record<string, unknown>;
  audio?: Record<string, unknown>;
}
let captured: CapturedBody | null = null;

function okFetch() {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    captured = init?.body ? (JSON.parse(init.body as string) as CapturedBody) : null;
    return {
      ok: true,
      json: async () => ({ messages: [{ id: "wamid.TEST" }] }),
    } as Response;
  });
}

const BASE = {
  phoneNumberId: "test-phone",
  accessToken: "test-token",
  to: "1234567890",
  link: "https://cdn.example.com/file",
} as const;

describe("sendMediaMessage — payload shape", () => {
  beforeEach(() => {
    captured = null;
    vi.stubGlobal("fetch", okFetch());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends image with a caption and no filename", async () => {
    await sendMediaMessage({ ...BASE, kind: "image", caption: "hello", filename: "x.png" });
    expect(captured?.type).toBe("image");
    expect(captured?.image).toEqual({ link: BASE.link, caption: "hello" });
    expect(captured?.image?.filename).toBeUndefined();
  });

  it("sends document with both caption and filename", async () => {
    await sendMediaMessage({
      ...BASE,
      kind: "document",
      caption: "invoice",
      filename: "invoice.pdf",
    });
    expect(captured?.type).toBe("document");
    expect(captured?.document).toEqual({
      link: BASE.link,
      caption: "invoice",
      filename: "invoice.pdf",
    });
  });

  it("sends audio with NO caption and NO filename (Meta rejects both)", async () => {
    await sendMediaMessage({
      ...BASE,
      kind: "audio",
      caption: "should be dropped",
      filename: "voice.ogg",
    });
    expect(captured?.type).toBe("audio");
    expect(captured?.audio).toEqual({ link: BASE.link });
  });

  it("throws when no link is provided", async () => {
    await expect(
      sendMediaMessage({ ...BASE, link: "", kind: "image" }),
    ).rejects.toThrow(/requires a link/);
  });
});

describe("uploadMediaToMeta — multipart upload", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts multipart form data and returns Meta's media id", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    let form: FormData | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        capturedUrl = url;
        capturedInit = init;
        form = init?.body instanceof FormData ? init.body : null;
        return { ok: true, json: async () => ({ id: "media-42" }) } as Response;
      }),
    );

    const result = await uploadMediaToMeta({
      phoneNumberId: "PNID-1",
      accessToken: "token-1",
      mimeType: "image/jpeg",
      fileName: "creative.jpg",
      bytes: new Uint8Array([1, 2, 3, 4]),
    });

    expect(result).toEqual({ mediaId: "media-42" });
    expect(capturedUrl).toContain("/PNID-1/media");
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.headers).toEqual({ Authorization: "Bearer token-1" });
    // `form` is only assigned inside the fetch stub, so re-widen it.
    const capturedForm = form as FormData | null;
    expect(capturedForm?.get("messaging_product")).toBe("whatsapp");
    expect(capturedForm?.get("type")).toBe("image/jpeg");
    const file = capturedForm?.get("file") as File;
    expect(file.name).toBe("creative.jpg");
    expect(file.type).toBe("image/jpeg");
    expect(file.size).toBe(4);
  });

  it("throws Meta's error message when the upload is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 400,
            json: async () => ({ error: { message: "Invalid parameter" } }),
          }) as Response,
      ),
    );

    await expect(
      uploadMediaToMeta({
        phoneNumberId: "PNID-1",
        accessToken: "token-1",
        mimeType: "image/jpeg",
        bytes: new Uint8Array([1]),
      }),
    ).rejects.toThrow("Invalid parameter");
  });
});
