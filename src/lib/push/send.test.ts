import { describe, expect, it } from "vitest";

import { messagePreview } from "./send";

describe("messagePreview", () => {
  it("uses the message text, collapsing whitespace", () => {
    expect(messagePreview("text", "  Olá,\n  tudo bem?  ")).toBe(
      "Olá, tudo bem?",
    );
  });

  it("truncates long text so notification bodies stay readable", () => {
    const preview = messagePreview("text", "a".repeat(500));
    expect(preview).toHaveLength(178);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("falls back to a media label when there is no caption", () => {
    expect(messagePreview("image", null)).toBe("📷 Imagem");
    expect(messagePreview("audio", "")).toBe("🎤 Áudio");
    expect(messagePreview("document", null)).toBe("📄 Documento");
    expect(messagePreview("location", null)).toBe("📍 Localização");
    expect(messagePreview("interactive", null)).toBe("💬 Resposta");
    expect(messagePreview(null, null)).toBe("💬 Nova mensagem");
  });

  it("prefers a caption over the media label", () => {
    expect(messagePreview("image", "Segue o comprovante")).toBe(
      "Segue o comprovante",
    );
  });
});
