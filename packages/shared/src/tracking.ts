/**
 * Courier tracking link (Lalamove share link) from whatever the owner pasted: the bare URL, the
 * app's share text with a label around it, or a link without the scheme. Returns a clean https
 * URL (LINE only allows http(s) in URI actions; we always store https) or null.
 */
const URL_RE = /\bhttps?:\/\/[^\s<>"'()]+|(?<![\w.:/])(?:[a-z0-9-]+\.)*lalamove\.com\/[^\s<>"'()]*/i;
const TRAILING = /[).,;:!?\]}>'"…]+$/;

export function extractTrackingUrl(text: string): string | null {
  const m = URL_RE.exec(text);
  if (!m) return null;
  let raw = m[0].replace(TRAILING, '');
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  raw = raw.replace(/^http:\/\//i, 'https://');
  return HTTPS_URL.test(raw) ? raw : null;
}

/** https://host.tld[:port][/path?query#frag] — host must be a dotted DNS name. */
const HTTPS_URL = /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d{1,5})?(?:[/?#][^\s]*)?$/i;

export function isLalamoveUrl(url: string): boolean {
  const host = /^https?:\/\/([^/?#:]+)/i.exec(url)?.[1] ?? '';
  return /(^|\.)lalamove\.com$/i.test(host);
}
