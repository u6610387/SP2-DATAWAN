'use client';
/**
 * LIFF: delivery recipient (name + Thai phone) for the rider / Lalamove card.
 * Required while the order is held for it (delivery.needsRecipient); pre-filled from the saved
 * profile on repeat orders; editable until the order is out for delivery.
 */
import { useState } from 'react';
import { formatThaiPhone, normalizeThaiPhone, type CustomerOrderView } from '@datawan/shared';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import type { Dictionary } from '@/lib/i18n/dictionary';

const LOCKED = new Set(['DELIVERING', 'DELIVERED', 'CANCELLED']);

export function showRecipientCard(order: CustomerOrderView): boolean {
  return !LOCKED.has(order.status) && (order.delivery.hasLocation || order.delivery.recipientName !== null);
}

export function RecipientCard({
  order,
  t,
  busy,
  onSave,
}: {
  order: CustomerOrderView;
  t: Dictionary;
  busy: boolean;
  onSave: (recipientName: string, recipientPhone: string) => Promise<void>;
}) {
  const { recipientName, recipientPhone, needsRecipient } = order.delivery;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(recipientName ?? '');
  const [phone, setPhone] = useState(recipientPhone ?? '');
  const [consent, setConsent] = useState(false);
  const normalized = normalizeThaiPhone(phone);
  const showPhoneError = phone.trim() !== '' && normalized === null;
  const canSave = name.trim() !== '' && normalized !== null && consent && !busy;

  if (!needsRecipient && !editing && recipientName && recipientPhone) {
    return (
      <Card>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle>{t.liff.recipientTitle}</CardTitle>
            <p className="mt-1 text-sm">{t.liff.recipientSummary(recipientName, formatThaiPhone(recipientPhone))}</p>
          </div>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => setEditing(true)}>
            {t.liff.recipientEdit}
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card className={needsRecipient ? 'border-2 border-[var(--brand)]' : undefined}>
      <CardTitle>{t.liff.recipientTitle}</CardTitle>
      {needsRecipient && <p className="mt-1 text-sm text-[var(--brand)]">{t.liff.recipientRequiredHint}</p>}
      <label className="mt-3 block text-xs text-[var(--muted)]" htmlFor="recipient-name">
        {t.liff.recipientNameLabel}
      </label>
      <Input id="recipient-name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
      <label className="mt-2 block text-xs text-[var(--muted)]" htmlFor="recipient-phone">
        {t.liff.recipientPhoneLabel}
      </label>
      <Input id="recipient-phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="08x-xxx-xxxx" value={phone} onChange={(e) => setPhone(e.target.value)} aria-invalid={showPhoneError} />
      {showPhoneError && <p className="mt-1 text-xs text-[var(--red)]">{t.liff.recipientPhoneInvalid}</p>}
      <label className="mt-3 flex items-start gap-2 text-xs text-[var(--muted)]">
        <input type="checkbox" className="mt-0.5" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>{t.liff.recipientConsent}</span>
      </label>
      <div className="mt-3 flex gap-2">
        {editing && (
          <Button variant="secondary" disabled={busy} onClick={() => setEditing(false)}>
            {t.liff.recipientCancel}
          </Button>
        )}
        <Button
          className="flex-1"
          size="lg"
          disabled={!canSave}
          onClick={async () => {
            await onSave(name.trim(), normalized!);
            setEditing(false);
          }}
        >
          {t.liff.recipientSave}
        </Button>
      </div>
    </Card>
  );
}
