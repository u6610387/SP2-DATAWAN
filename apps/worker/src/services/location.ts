/** Location parsing for chat fallback (step 2). Geocoding typed addresses is TODO (Longdo → OSM). */

/** Extract lat/lng from Google Maps / LINE / OSM style links or a raw "13.7,100.4" pair. */
export function parseMapsLink(text: string): { lat: number; lng: number } | null {
  const patterns = [
    /@(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/, // google.com/maps/@13.7,100.4,17z
    /[?&](?:q|query|ll|destination)=(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/,
    /!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/,
    /^\s*(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})\s*$/,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) {
      const lat = Number(m[1]);
      const lng = Number(m[2]);
      if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
    }
  }
  return null;
}

export function isMapsUrl(text: string): boolean {
  return /https?:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps|(www\.)?google\.[a-z.]+\/maps|maps\.google\.|www\.openstreetmap\.org|line\.me\/R\/nv\/location)/i.test(text);
}

/** Heuristic: does this look like a typed Thai address? */
export function looksLikeAddress(text: string): boolean {
  return /(บ้านเลขที่|เลขที่|ซอย|ซ\.|ถนน|ถ\.|แขวง|เขต|ตำบล|อำเภอ|จังหวัด|หมู่บ้าน|คอนโด|\d{1,4}\/\d{1,4}|\b[1-9]\d{4}\b)/.test(text) && text.length >= 10;
}

export function mapUrl(lat: number | null, lng: number | null): string | null {
  return lat !== null && lng !== null ? `https://www.google.com/maps/search/?api=1&query=${lat},${lng}` : null;
}
