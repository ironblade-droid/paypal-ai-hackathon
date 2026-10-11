// Demo shop catalog (sandbox test products; prices are set server-side so the browser cannot change them).
export const CATALOG = [
  { sku: 'STK-001', name: 'Sticker pack (dispute-demo item)', price: '5.50', type: 'PHYSICAL', note: 'USD 5.00-5.99 lets sandbox disputes simulate escalation.' },
  { sku: 'MUG-002', name: 'Ceramic mug', price: '18.00', type: 'PHYSICAL' },
  { sku: 'CAM-003', name: 'Refurbished camera', price: '820.00', type: 'PHYSICAL', note: 'Over USD 750: triggers the signature-confirmation check.' },
  { sku: 'EBK-004', name: 'E-book (digital)', price: '9.00', type: 'DIGITAL', note: 'Digital goods: shows the not-physical-goods warning.' },
];
export const findSku = (sku) => CATALOG.find(p => p.sku === sku);
