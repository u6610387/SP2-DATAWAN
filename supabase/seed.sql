-- Dev seed. Replace products with the owner's real list (name + slang aliases).
insert into settings(key, value) values
  ('default_markup',          '0.25'),
  ('payment_expiry_minutes',  '45'),
  ('owner_reminder_minutes',  '15'),
  ('owner_politeness',        '"ค่ะ"')
on conflict (key) do nothing;

insert into products(name_th, aliases, unit, prep_types) values
  ('กุ้งแม่น้ำ',  '{กุ้งแม่น้ำ,กุ้งก้ามกราม,กุ้งใหญ่}', 'kg', '{live,chilled}'),
  ('กุ้งขาว',    '{กุ้งขาว,กุ้งแวนนาไม}',             'kg', '{live,chilled}'),
  ('ปูม้า',      '{ปูม้า,ปู}',                         'kg', '{live,chilled,cooked}'),
  ('หอยแครง',   '{หอยแครง,แครง}',                    'kg', '{live}'),
  ('หมึกกล้วย',  '{หมึกกล้วย,ปลาหมึกกล้วย,หมึก}',      'kg', '{chilled}'),
  ('กั้ง',       '{กั้ง,กั้งกระดาน}',                  'kg', '{live,chilled}'),
  ('ปลากะพง',   '{ปลากะพง,กะพง,ปลากะพงขาว,กะพงขาว}',   'kg', '{live,chilled}');
