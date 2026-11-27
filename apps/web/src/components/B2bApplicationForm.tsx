'use client';
/**
 * LIFF: B2B ("shop / business") application form. The customer only suggests data; the owner
 * verifies it (CLAUDE.md §3.1). A Tax ID that fails the checksum is warned about but still
 * submittable: the owner sees the flag. Renders from props alone (no browser APIs until a handler runs).
 */
import { useState } from 'react';
import { isValidThaiTaxId, type B2bApplyRequest, type BusinessType, type CustomerAccountView } from '@datawan/shared';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { compressImage } from '@/lib/compressImage';
import type { Dictionary } from '@/lib/i18n/dictionary';

const MAX_PHOTOS = 3;
const BUSINESS_TYPES: BusinessType[] = ['restaurant', 'reseller', 'hotel', 'other'];

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
  onSubmit: (fields: B2bFormFields, photos: Blob[]) => Promise<void>;
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

  const taxIdComplete = values.taxId.length === 13;
  const taxIdOk = values.taxId === '' || taxIdComplete;
  const taxIdWarn = taxIdComplete && !isValidThaiTaxId(values.taxId);
  const windowOk = (values.windowFrom === '') === (values.windowTo === '');
  const canSubmit = values.businessName.trim() !== '' && values.addressText.trim().length >= 5 && taxIdOk && windowOk && values.consent && !busy;

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
      setPhotos((p) => (p.length < MAX_PHOTOS ? [...p, blob] : p));
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

      {showForm && (
        <Card>
          <label className="block text-xs text-[var(--muted)]" htmlFor="b2b-name">
            {t.account.businessName}
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
            {t.account.address}
          </label>
          <textarea
            id="b2b-address"
            rows={3}
            maxLength={300}
            className="w-full rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm"
            value={values.addressText}
            onChange={(e) => set('addressText', e.target.value)}
          />
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

          <label className="mt-2 block text-xs text-[var(--muted)]" htmlFor="b2b-taxid">
            {t.account.taxId}
          </label>
          <Input
            id="b2b-taxid"
            inputMode="numeric"
            maxLength={13}
            value={values.taxId}
            onChange={(e) => set('taxId', e.target.value.replace(/\D/g, '').slice(0, 13))}
            aria-invalid={taxIdWarn}
          />
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
            {photos.length < MAX_PHOTOS && (
              <label className="inline-flex h-9 cursor-pointer items-center rounded-xl border border-[var(--border)] px-3 text-sm">
                {t.account.addPhoto}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  disabled={busy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) void addPhoto(file);
                  }}
                />
              </label>
            )}
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

          <Button
            className="mt-3"
            size="lg"
            disabled={!canSubmit}
            onClick={() =>
              void onSubmit(
                {
                  businessName: values.businessName.trim(),
                  businessType: values.businessType,
                  addressText: values.addressText.trim(),
                  lat: coords?.lat ?? null,
                  lng: coords?.lng ?? null,
                  deliveryWindow: values.windowFrom && values.windowTo ? `${values.windowFrom}-${values.windowTo}` : null,
                  taxId: values.taxId === '' ? null : values.taxId,
                  pdpaConsent: true,
                },
                photos,
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
