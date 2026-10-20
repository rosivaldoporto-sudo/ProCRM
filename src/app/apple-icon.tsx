import { renderAppIcon } from "@/lib/pwa/app-icon";

// Apple touch icon for "Add to Home Screen". iOS doesn't use the
// manifest icons for the home-screen badge — it looks for this route
// (or a literal apple-icon.png) at 180×180.
export const runtime = "edge";
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return renderAppIcon(180);
}
