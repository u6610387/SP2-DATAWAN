# Labeling Guide (v1)

Applies to `eval/datasets/*/samples.jsonl`. Two labelers per sample; disagreements go to a third member.

## Units
| Customer wrote | Label |
|---|---|
| โล, กิโล, กก., kg | `kg` |
| ครึ่งโล | `qty: 0.5, unit: kg` |
| ขีด | `qty: 0.1 × n, unit: kg` |
| ตัว, ตัวละ | `piece` |
| กล่อง / ถาด / ชุด | `box` / `tray` / `set` |
| no number ("เอาหมึกครับ") | `qty: null, unit: null`, add `qty` to `missing_fields` |

## Products
- Map to `product_ref` using `catalog.json` aliases. Not in catalog → `null`.
- Size words ("ไซส์ 40", "ตัวใหญ่") are notes, not separate products. Do not label `note`.

## Prep type
- เป็นๆ / สด เป็น → `live`; แช่เย็น / น้ำแข็ง → `chilled`; แช่แข็ง → `frozen`; ต้ม / นึ่ง / สุก → `cooked`; not stated → `any` (and do not add to `missing_fields` unless the product needs it).

## Delivery time
- Resolve relative times with `now_bangkok`. "เช้า" = 07:00, "สาย" = 10:00, "บ่าย" = 14:00, "เย็น" = 17:00. Not stated → `iso: null` and add `delivery_time` to `missing_fields` only for B2B.

## Slips / bills
- Amounts in baht as printed (1,970.00 → `1970`). Dates in ค.ศ. with `+07:00`.
- Receiver: copy as printed, including masking (`xxx-x-x1234-x`).
- Non-slip images: `is_slip: false`, everything else `null`.

## PII spans
List every phone, name, address and account number in `pii_spans` with its type, exactly as it appears in `input` (after anonymization), so the leak test can check it.
