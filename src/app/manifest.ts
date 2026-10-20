import type { MetadataRoute } from "next";

/**
 * Web App Manifest — makes the "Add to Home Screen" install behave like
 * a native app (no Safari chrome, own icon) and, crucially on iOS, is
 * what unlocks Web Push for the installed PWA.
 *
 * iOS 16.4+ only delivers push notifications to web apps opened from
 * the Home Screen, served over HTTPS, with a manifest declaring
 * `display: standalone`. The existing `appleWebApp` metadata in
 * layout.tsx covers older iOS versions; this file covers the modern
 * install path and Android/Chrome.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "ProCRM",
    short_name: "ProCRM",
    description:
      "CRM completo para WhatsApp com painel compartilhado, contatos, pipeline de vendas, transmissões e automações.",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    background_color: "#020617",
    theme_color: "#020617",
    icons: [
      {
        src: "/icons/192",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/512",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/512",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
