import type { CatalogProduct } from '../src/types';
export const products: CatalogProduct[] = [
  { id: 'uuid-kung-maenam', name_th: 'กุ้งแม่น้ำ', aliases: ['กุ้งก้ามกราม'], unit: 'kg', prep_types: ['live', 'chilled'] },
  { id: 'uuid-kung-khao', name_th: 'กุ้งขาว', aliases: ['กุ้งแวนนาไม'], unit: 'kg', prep_types: ['live', 'chilled'] },
  { id: 'uuid-pu-ma', name_th: 'ปูม้า', aliases: ['ปู'], unit: 'kg', prep_types: ['live', 'chilled', 'cooked'] },
  { id: 'uuid-hoi-kraeng', name_th: 'หอยแครง', aliases: ['แครง'], unit: 'kg', prep_types: ['live'] },
  { id: 'uuid-muek', name_th: 'หมึกกล้วย', aliases: ['ปลาหมึกกล้วย', 'หมึก'], unit: 'kg', prep_types: ['chilled'] },
];
export const NOW = new Date('2027-01-14T02:20:00Z'); // 09:20 Bangkok
