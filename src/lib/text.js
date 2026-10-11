// Text normalisation used before every outcome / win-word check and value extraction, on every path (model and seller).
// NFKC folds full-width and compatibility forms; zero-width and bidi control characters are removed; common Cyrillic and
// Greek look-alikes are mapped to Latin letters.
const HIDDEN = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/g;
const CONFUSABLES = {
  'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'і': 'i', 'ї': 'i', 'ј': 'j', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x', 'ѕ': 's', 'ԁ': 'd', 'ԛ': 'q', 'ԝ': 'w', 'ӏ': 'l', 'ɡ': 'g',
  'А': 'A', 'В': 'B', 'Е': 'E', 'І': 'I', 'Ј': 'J', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'У': 'Y', 'Х': 'X', 'Ѕ': 'S', 'Ԝ': 'W',
  'α': 'a', 'ε': 'e', 'ι': 'i', 'ο': 'o', 'ρ': 'p', 'υ': 'u', 'ν': 'v', 'κ': 'k', 'τ': 't', 'χ': 'x',
  'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X',
};
const CONF_RE = new RegExp(`[${Object.keys(CONFUSABLES).join('')}]`, 'g');
export function hasHiddenChars(s) { HIDDEN.lastIndex = 0; return HIDDEN.test(String(s)); }
export function normalizeText(s) {
  return String(s ?? '').normalize('NFKC').replace(HIDDEN, '').replace(CONF_RE, (c) => CONFUSABLES[c] || c);
}
