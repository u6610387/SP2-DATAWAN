'use client';
/**
 * LIFF: B2B ("shop / business") application form. The customer only suggests data; the owner
 * verifies it (CLAUDE.md §3.1). A Tax ID that fails the checksum is warned about but still
 * submittable: the owner sees the flag. Renders from props alone (no browser APIs until a handler runs).
 */
import { useState } from 'react';
import { isValidThaiTaxId, type B2bApplyRequest, type BusinessType, type CustomerAccountView } from '@datawan/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { compressImage } from '@/lib/compressImage';
import { ApiRequestError } from '@/lib/api';
import type { Dictionary } from '@/lib/i18n/dictionary';

/** Un-purged documents per user (the worker enforces the same cap). */
const MAX_DOCUMENTS = 3;
const BUSINESS_TYPES: BusinessType[] = ['restaurant', 'reseller', 'hotel', 'other'];

/** Why the form can't be sent yet, in form order. The Tax ID checksum only warns (owner sees ✗). */
export type MissingRequirement = 'businessName' | 'address' | 'taxIdLength' | 'deliveryWindow' | 'consent';

export function missingRequirements(v: B2bFormValues): MissingRequirement[] {
  const out: MissingRequirement[] = [];
  if (v.businessName.trim() === '') out.push('businessName');
  if (v.addressText.trim().length < 5) out.push('address');
  if (v.taxId !== '' && v.taxId.length !== 13) out.push('taxIdLength');
  if ((v.windowFrom === '') !== (v.windowTo === '')) out.push('deliveryWindow');
  if (!v.consent) out.push('consent');
  return out;
}

export interface B2bFormValues {
  businessName: string;
  businessType: BusinessType;
  addressText: string;
  windowFrom: string;
  windowTo: string;
  taxId: string;
  consent: boolean;
}

/** What the form hands to the page; the page uploads `photos` and fills `documentPaths`. */
export type B2bFormFields = Omit<B2bApplyRequest, 'documentPaths'>;

/**
 * How many new photos this submit may add: 3 minus the documents already on file. A rejected
 * application's documents are purged when the customer re-applies, so they do not count.
 */
export function maxNewPhotos(account: CustomerAccountView): number {
  const b = account.b2b;
  if (!b || b.status === 'REJECTED') return MAX_DOCUMENTS;
  return Math.max(0, MAX_DOCUMENTS - b.documents.length);
}

/** A photo PUT to the signed upload URL failed. */
export class UploadError extends Error {}

/** Customer-facing copy for a failed submit, by API error code; never the server's English message. */
export function accountErrorMessage(e: unknown, t: Dictionary): string {
  if (!(e instanceof ApiRequestError)) return e instanceof UploadError ? t.account.errors.uploadFailed : t.account.errors.generic;
  switch (e.code) {
    case 'VALIDATION_FAILED':
      return t.account.errors.validation;
    case 'INVALID_FROM_STATE':
      return t.account.errors.invalidState;
    case 'TOO_MANY_DOCUMENTS':
      return t.account.errors.tooManyDocuments;
    default:
      return t.account.errors.generic;
  }
}

/** Runs the page's submit; on success clears the sent photos and the consent tick (they are on file now). */
export async function submitAndReset(submit: () => Promise<boolean>, reset: () => void): Promise<void> {
  if (await submit()) reset();
}

function initialFrom(account: CustomerAccountView): B2bFormValues {
  const b = account.b2b;
  const [windowFrom = '', windowTo = ''] = b?.deliveryWindow?.split('-') ?? [];
  return {
    businessName: b?.businessName ?? '',
    businessType: b?.businessType ?? 'restaurant',
    addressText: b?.addressText ?? '',
    windowFrom,
    windowTo,
    taxId: b?.taxId ?? '',
    consent: false,
  };
}

export function B2bApplicationForm({
  account,
  t,
  busy,
  onSubmit,
  initialValues,
}: {
  account: CustomerAccountView;
  t: Dictionary;
  busy: boolean;
  /** Resolves true when the application was saved; the form then clears photos and consent. */
  onSubmit: (fields: B2bFormFields, photos: Blob[]) => Promise<boolean>;
  initialValues?: Partial<B2bFormValues>;
}) {
  const b = account.b2b;
  const [values, setValues] = useState<B2bFormValues>({ ...initialFrom(account), ...initialValues });
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(b?.lat != null && b.lng != null ? { lat: b.lat, lng: b.lng } : null);
  const [locationError, setLocationError] = useState(false);
  const [photos, setPhotos] = useState<Blob[]>([]);
  const [photoError, setPhotoError] = useState(false);
  // A rejected application stays collapsed behind "สมัครใหม่"; the toggle can also hide the form.
  const [showForm, setShowForm] = useState(b?.status !== 'REJECTED');
  const set = <K extends keyof B2bFormValues>(k: K, v: B2bFormValues[K]) => setValues((p) => ({ ...p, [k]: v }));
  const photoSlots = maxNewPhotos(account);
  const remaining = Math.max(0, photoSlots - photos.length);

  const taxIdWarn = values.taxId.length === 13 && !isValidThaiTaxId(values.taxId);
  // One source for both the disabled button and the hints, so they can't disagree.
  const missing = missingRequirements(values);
  const canSubmit = missing.length === 0 && !busy;
  const addressShort = values.addressText.trim() !== '' && values.addressText.trim().length < 5;

  const formFields = (): B2bFormFields => ({
    businessName: values.businessName.trim(),
    businessType: values.businessType,
    addressText: values.addressText.trim(),
    lat: coords?.lat ?? null,
    lng: coords?.lng ?? null,
    deliveryWindow: values.windowFrom && values.windowTo ? `${values.windowFrom}-${values.windowTo}` : null,
    taxId: values.taxId === '' ? null : values.taxId,
    pdpaConsent: true,
  });

  function useCurrentLocation() {
    setLocationError(false);
    if (!navigator.geolocation) return setLocationError(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords;
        // Same bounds as B2bApplyRequest (Thailand); outside → treat as unavailable.
        if (lat < 5 || lat > 21 || lng < 97 || lng > 106) return setLocationError(true);
        setCoords({ lat, lng });
      },
      () => setLocationError(true),
      { timeout: 10_000 },
    );
  }

  async function addPhoto(file: File) {
    setPhotoError(false);
    try {
      const blob = await compressImage(file);
      setPhotos((p) => (p.length < photoSlots ? [...p, blob] : p));
    } catch {
      setPhotoError(true);
    }
  }

  return (
    <div className="space-y-4">
      {b && <StatusBanner b={b} t={t} onReapply={() => setShowForm(true)} showReapply={!showForm} />}

      <div className="grid grid-cols-2 gap-2" role="group">
        <Button variant={showForm ? 'secondary' : 'primary'} size="md" disabled={busy} aria-pressed={!showForm} onClick={() => setShowForm(false)}>
          {t.account.typeB2c}
        </Button>
        <Button variant={showForm ? 'primary' : 'secondary'} size="md" disabled={busy} aria-pressed={showForm} onClick={() => setShowForm(true)}>
          {t.account.typeB2b}
        </Button>
      </div>

      {!showForm && <GeneralAccountCard account={account} t={t} onSwitchToBusiness={() => setShowForm(true)} />}

      {showForm && (
        <Card>
          <label className="block text-xs text-[var(--muted)]" htmlFor="b2b-name">
            {t.account.businessName} <span className="text-[var(--red)]" aria-hidden="true">*</span>
          </label>
          <Input id="b2b-name" maxLength={100} value={values.businessName} onChange={(e) => set('businessName', e.target.value)} />

          <label className="mt-2 block text-xs text-[var(--muted)]" htmlFor="b2b-type">
            {t.account.businessType}
          </label>
          <select
            id="b2b-type"
            className="h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 text-sm"
            value={values.businessType}
            onChange={(e) => set('businessType', e.target.value as BusinessType)}
          >
            {BUSINESS_TYPES.map((k) => (
              <option key={k} value={k}>
                {t.account.types[k]}
              </option>
            ))}
          </select>

          <label className="mt-2 block text-xs text-[var(--muted)]" htmlFor="b2b-address">
            {t.account.address} <span className="text-[var(--red)]" aria-hidden="true">*</span>
          </label>
          <textarea
            id="b2b-address"
            rows={3}
            maxLength={300}
            className="w-full rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm"
            value={values.addressText}
            onChange={(e) => set('addressText', e.target.value)}
            aria-invalid={addressShort}
          />
          {addressShort && <p className="mt-1 text-xs text-[var(--red)]">{t.account.hints.addressShort}</p>}
          <div className="mt-2 flex items-center gap-2">
            <Button variant="secondary" size="sm" type="button" disabled={busy} onClick={useCurrentLocation}>
              {t.account.useLocation}
            </Button>
            {coords && <span className="text-xs text-[var(--muted)]">{t.account.locationSet}</span>}
            {locationError && <span className="text-xs text-[var(--yellow)]">{t.account.locationError}</span>}
          </div>

          <div className="mt-2 text-xs text-[var(--muted)]">{t.account.deliveryWindow}</div>
          <div className="mt-1 flex items-center gap-2">
            <Input type="time" aria-label={t.account.windowFrom} value={values.windowFrom} onChange={(e) => set('windowFrom', e.target.value)} />
            <span className="text-sm">–</span>
            <Input type="time" aria-label={t.account.windowTo} value={values.windowTo} onChange={(e) => set('windowTo', e.target.value)} />
          </div>
          {missing.includes('deliveryWindow') && <p className="mt-1 text-xs text-[var(--red)]">{t.account.hints.deliveryWindow}</p>}

          <label className="mt-2 block text-xs text-[var(--muted)]" htmlFor="b2b-taxid">
            {t.account.taxId}
          </label>
          <Input
            id="b2b-taxid"
            inputMode="numeric"
            maxLength={13}
            value={values.taxId}
            onChange={(e) => set('taxId', e.target.value.replace(/\D/g, '').slice(0, 13))}
            aria-invalid={taxIdWarn || missing.includes('taxIdLength')}
          />
          {missing.includes('taxIdLength') && <p className="mt-1 text-xs text-[var(--red)]">{t.account.hints.taxIdLength(values.taxId.length)}</p>}
          {taxIdWarn && <p className="mt-1 text-xs text-[var(--yellow)]">{t.account.taxIdInvalid}</p>}

          <div className="mt-3 text-xs text-[var(--muted)]">
            {t.account.photos} · {t.account.photosHint}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {photos.map((_, i) => (
              <span key={i} className="flex items-center gap-1 rounded-full bg-black/5 px-3 py-1 text-xs">
                🖼️ {i + 1}
                <button type="button" className="text-[var(--red)]" onClick={() => setPhotos((p) => p.filter((__, j) => j !== i))}>
                  {t.account.removePhoto}
                </button>
              </span>
            ))}
            <label
              aria-disabled={remaining === 0}
              className={`inline-flex h-9 items-center rounded-xl border border-[var(--border)] px-3 text-sm ${remaining === 0 ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'}`}
            >
              {t.account.addPhoto}
              <input
                type="file"
                accept="image/*"
                className="hidden"
                disabled={busy || remaining === 0}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void addPhoto(file);
                }}
              />
            </label>
            <span className="text-xs text-[var(--muted)]">{t.account.photosRemaining(remaining)}</span>
          </div>
          {photoError && <p className="mt-1 text-xs text-[var(--red)]">{t.liff.uploadError}</p>}

          {/* Big tap target, same style as the recipient PDPA consent. */}
          <label
            htmlFor="b2b-consent"
            className="mt-3 flex min-h-12 cursor-pointer select-none items-center gap-3 rounded-xl border border-[var(--border)] px-3 py-3 text-sm active:bg-black/5"
          >
            <input
              id="b2b-consent"
              type="checkbox"
              className="h-6 w-6 shrink-0 cursor-pointer accent-[var(--brand)]"
              checked={values.consent}
              onChange={(e) => set('consent', e.target.checked)}
            />
            <span>{t.account.consent}</span>
          </label>

          {missing.length > 0 && !busy && (
            <div className="mt-3 rounded-xl bg-[var(--red-bg)] px-3 py-2 text-xs text-[var(--red)]" role="status" aria-live="polite">
              <p className="font-semibold">{t.account.hints.title}</p>
              <ul className="mt-1 list-disc pl-5">
                {missing.map((m) => (
                  <li key={m}>{m === 'taxIdLength' ? t.account.hints.taxIdLength(values.taxId.length) : t.account.hints[m]}</li>
                ))}
              </ul>
            </div>
          )}

          <Button
            className="mt-3"
            size="lg"
            disabled={!canSubmit}
            onClick={() =>
              void submitAndReset(
                () => onSubmit(formFields(), photos),
                () => {
                  setPhotos([]);
                  set('consent', false);
                },
              )
            }
          >
            {busy ? t.account.submitting : t.account.submit}
          </Button>
        </Card>
      )}
    </div>
  );
}

function StatusBanner({
  b,
  t,
  onReapply,
  showReapply,
}: {
  b: NonNullable<CustomerAccountView['b2b']>;
  t: Dictionary;
  onReapply: () => void;
  showReapply: boolean;
}) {
  const label = b.status === 'VERIFIED' ? t.account.statusVerified : b.status === 'REJECTED' ? t.account.statusRejected : t.account.statusPending;
  return (
    <Card>
      <CardTitle>{label}</CardTitle>
      {b.status === 'REJECTED' && b.rejectionReason && <p className="mt-1 text-sm text-[var(--red)]">{t.account.rejectionReason(b.rejectionReason)}</p>}
      {b.needsRereview && <p className="mt-1 rounded-lg bg-[var(--yellow-bg,rgba(0,0,0,0.05))] p-2 text-sm">{t.account.rereview}</p>}
      {b.status === 'REJECTED' && showReapply && (
        <Button className="mt-3" variant="secondary" onClick={onReapply}>
          {t.account.reapply}
        </Button>
      )}
    </Card>
  );
}

/**
 * The "ลูกค้าทั่วไป" tab: a status card instead of a blank area, so the page never looks
 * unloaded. A verified shop sees its shop status here, not "general customer". Pure (props only).
 */
export function GeneralAccountCard({ account, t, onSwitchToBusiness }: { account: CustomerAccountView; t: Dictionary; onSwitchToBusiness: () => void }) {
  const verified = account.type === 'B2B' && account.b2b?.status === 'VERIFIED';
  return (
    <Card className="space-y-3">
      <Badge className={verified ? 'bg-[var(--green-bg)] text-[var(--green)]' : 'bg-black/5 text-[var(--fg)]'}>
        {verified ? t.account.verifiedShopTitle : t.account.generalTitle}
      </Badge>
      {verified ? (
        <p className="text-sm">{t.account.verifiedShopNote}</p>
      ) : (
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>{t.account.generalOrderNote}</li>
          <li>{t.account.generalPinNote}</li>
        </ul>
      )}
      <div className="space-y-2 border-t border-[var(--border)] pt-3">
        {!verified && <p className="text-xs text-[var(--muted)]">{t.account.switchToBusinessHint}</p>}
        <Button type="button" variant="secondary" size="md" className="w-full" onClick={onSwitchToBusiness}>
          {verified ? t.account.viewShopDetails : t.account.switchToBusiness}
        </Button>
      </div>
    </Card>
  );
}
