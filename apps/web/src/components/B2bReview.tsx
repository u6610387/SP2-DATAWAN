'use client';
import { useState } from 'react';
import type { OwnerB2bDetailView } from '@datawan/shared';
import { Button } from '@/components/ui/button';
import type { Dictionary } from '@/lib/i18n/dictionary';

export const REASON_MAX = 200;
export const reasonValid = (r: string) => r.trim().length >= 1 && r.trim().length <= REASON_MAX;

export function B2bDetailFields({ view, t }: { view: OwnerB2bDetailView; t: Dictionary }) {
  const c = t.customers;
  return (
    <dl className="space-y-2 text-sm">
      <div className="font-semibold">{view.businessName}</div>
      {view.customerName && <div className="text-[var(--muted)]">{view.customerName}</div>}
      {view.phone && <div>{c.phone}: {view.phone}</div>}
      <div>{c.address}: {view.addressText}</div>
      {view.mapUrl && (
        <a href={view.mapUrl} target="_blank" rel="noopener noreferrer" className="text-[var(--brand)] underline">
          {c.openMap}
        </a>
      )}
      {view.deliveryWindow && <div>{c.deliveryWindow}: {view.deliveryWindow}</div>}
      {view.taxId && (
        <div>
          {c.taxId}: {view.taxId}{' '}
          {view.taxIdValid === true && <span className="text-[var(--green)]">{c.taxIdValid}</span>}
          {view.taxIdValid === false && <span className="text-[var(--red)]">{c.taxIdInvalid}</span>}
        </div>
      )}
      {view.rereviewFields.length > 0 && <div className="text-[var(--yellow)]">{c.rereviewFields(view.rereviewFields.join(', '))}</div>}
      {view.rejectionReason && <div className="text-[var(--red)]">{c.rejectionReason(view.rejectionReason)}</div>}
      <div>
        <div className="mb-1 text-[var(--muted)]">{c.photos}</div>
        {view.documents.length === 0 ? (
          <div className="text-xs text-[var(--muted)]">{c.noPhotos}</div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {view.documents.map((d) => (
              <a key={d.id} href={d.url} target="_blank" rel="noopener noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={d.url} alt="" className="h-24 w-24 rounded-lg border border-[var(--border)] object-cover" />
              </a>
            ))}
          </div>
        )}
      </div>
    </dl>
  );
}

type Step = null | 'approve' | 'reject' | 'revoke';

/** Presentational: which buttons show depends only on the view's state. Confirm step is in-page. */
export function B2bActions({
  view, t, busy, onApprove, onReject, onAcknowledge, onRevoke,
}: {
  view: OwnerB2bDetailView;
  t: Dictionary;
  busy: boolean;
  onApprove: () => void | Promise<void>;
  onReject: (reason: string) => void | Promise<void>;
  onAcknowledge: () => void | Promise<void>;
  onRevoke: (reason: string) => void | Promise<void>;
}) {
  const c = t.customers;
  const [step, setStep] = useState<Step>(null);
  const [reason, setReason] = useState('');
  const pending = view.status === 'PENDING_VERIFICATION';
  const verified = view.status === 'VERIFIED';
  if (!pending && !verified) return null;

  const close = () => { setStep(null); setReason(''); };

  if (step === 'approve') {
    return (
      <div className="space-y-2">
        <p className="text-sm font-medium">{c.approveConfirm}</p>
        <div className="flex gap-2">
          <Button disabled={busy} onClick={() => onApprove()}>{c.confirm}</Button>
          <Button variant="secondary" disabled={busy} onClick={close}>{c.cancel}</Button>
        </div>
      </div>
    );
  }
  if (step === 'reject' || step === 'revoke') {
    return (
      <div className="space-y-2">
        <label htmlFor="b2b-reason" className="text-sm font-medium">{c.reasonLabel}</label>
        <textarea
          id="b2b-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={REASON_MAX + 50}
          rows={3}
          placeholder={c.reasonHint}
          className="w-full rounded-xl border border-[var(--border)] bg-[var(--card)] p-3 text-sm"
        />
        <div className="flex gap-2">
          <Button
            variant="danger"
            disabled={busy || !reasonValid(reason)}
            onClick={() => (step === 'reject' ? onReject(reason.trim()) : onRevoke(reason.trim()))}
          >
            {c.confirm}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={close}>{c.cancel}</Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-2">
      {pending && <Button disabled={busy} onClick={() => setStep('approve')}>{c.approve}</Button>}
      {pending && <Button variant="danger" disabled={busy} onClick={() => setStep('reject')}>{c.reject}</Button>}
      {verified && view.needsRereview && <Button disabled={busy} onClick={() => onAcknowledge()}>{c.acknowledge}</Button>}
      {verified && <Button variant="danger" disabled={busy} onClick={() => setStep('revoke')}>{c.revoke}</Button>}
    </div>
  );
}
