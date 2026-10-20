import { renderAppIcon } from "@/lib/pwa/app-icon";

// Icons referenced by `src/app/manifest.ts` and by the service worker's
// `showNotification()` calls. Chrome requires a 192px and a 512px icon
// for installability; iOS uses /apple-icon instead.
export const runtime = "edge";

const SIZES = new Set([180, 192, 512]);

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ size: string }> },
) {
  const { size: rawSize } = await params;
  const size = Number.parseInt(rawSize.replace(/\.png$/, ""), 10);

  if (!SIZES.has(size)) {
    return new Response("Not found", { status: 404 });
  }

  const icon = renderAppIcon(size);
  icon.headers.set(
    "Cache-Control",
    "public, max-age=31536000, immutable",
  );
  return icon;
}
