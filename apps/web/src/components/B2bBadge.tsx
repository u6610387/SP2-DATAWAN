import { Badge } from '@/components/ui/badge';

/** Reads only `customer.b2b` (non-null for VERIFIED shops), never `customer.type`. */
export function B2bBadge({ b2b }: { b2b: { businessName: string; deliveryWindow: string | null } | null }) {
  if (!b2b) return null;
  return <Badge className="bg-[var(--green-bg)] text-[var(--green)]">[B2B - {b2b.businessName}]</Badge>;
}
