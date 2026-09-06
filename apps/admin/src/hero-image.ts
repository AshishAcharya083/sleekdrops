/**
 * Hero-image drop rules, shared by the two surfaces that accept one (the
 * manual-topic drawer and the pipeline article panel) and mirrored by the
 * agent's own guard in `apps/agent/src/tools/heroImages.ts`.
 *
 * The browser check is the fast, friendly half: it names the problem before a
 * 10 MB upload crosses the wire. The server still re-checks every byte - it
 * sniffs the real format rather than trusting the type the browser declared -
 * because the panel is not the only thing that can call the API.
 *
 * Pure and DOM-free on purpose, so it is unit-tested in isolation.
 */

/** Same cap as MAX_HERO_IMAGE_BYTES in the agent. */
export const MAX_HERO_IMAGE_BYTES = 10 * 1024 * 1024;

/** The formats the website renders as heroes. No SVG: it can carry script. */
export const HERO_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/** `accept` for the file input - extensions too, since some OS pickers need them. */
export const HERO_IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp';

const EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

/** The parts of a dropped File this module needs - keeps it testable. */
export interface PickedImage {
  name: string;
  type: string;
  size: number;
}

/** Human file size, e.g. "1.4 MB" / "820 KB". */
export function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Why this file can't be a hero image, or null when it can. Drag-and-drop from
 * some file managers hands over an empty `type`, so the extension is accepted
 * as evidence too - the server sniffs the bytes either way.
 */
export function validateHeroImage(file: PickedImage): string | null {
  const type = file.type.toLowerCase();
  const named = file.name.toLowerCase();
  const looksRight =
    (HERO_IMAGE_TYPES as readonly string[]).includes(type) ||
    (type === '' && EXTENSIONS.some((ext) => named.endsWith(ext)));
  if (!looksRight) {
    return `${file.name}: use a JPEG, PNG or WebP image`;
  }
  if (file.size === 0) return `${file.name}: the file is empty`;
  if (file.size > MAX_HERO_IMAGE_BYTES) {
    return `${file.name}: ${formatBytes(file.size)} exceeds the ${MAX_HERO_IMAGE_BYTES / 1024 / 1024} MB limit`;
  }
  return null;
}
