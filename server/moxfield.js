// Importación de mazos públicos de Moxfield por link.
//
// Moxfield no ofrece una API pública ni login para apps externas, y sus términos
// prohíben el scraping sin autorización. El acceso autorizado se solicita a
// support@moxfield.com, que entrega un User-Agent propio para la app. Por eso este
// importador queda APAGADO hasta que se configure MOXFIELD_USER_AGENT con ese valor.

export class ImportError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const ID = /^[A-Za-z0-9_-]{6,64}$/;

/** Extrae el id público desde un link de Moxfield (o acepta el id directo). */
export function parseMoxfieldUrl(input) {
  const raw = String(input ?? '').trim();
  if (ID.test(raw)) return raw;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ImportError('Pega un link como https://moxfield.com/decks/abc123');
  }
  if (!/(^|\.)moxfield\.com$/i.test(url.hostname)) throw new ImportError('El link debe ser de moxfield.com');
  const m = url.pathname.match(/^\/decks\/([A-Za-z0-9_-]{6,64})/);
  if (!m) throw new ImportError('No reconozco el id del mazo en ese link');
  return m[1];
}

// Moxfield ha usado dos formas de respuesta: v2 ({ mainboard: { nombre: entrada } })
// y v3 ({ boards: { mainboard: { cards: { id: entrada } } } }). Se aceptan ambas.
function boardEntries(json, board) {
  const v3 = json?.boards?.[board]?.cards;
  const v2 = json?.[board];
  const src = v3 ?? v2;
  if (!src || typeof src !== 'object') return [];
  return Object.values(src);
}

function entryLine(entry) {
  const card = entry?.card ?? {};
  const name = String(card.name ?? '').trim();
  if (!name) return null;
  const qty = Math.max(1, Math.min(99, Number(entry.quantity) || 1));
  const set = typeof card.set === 'string' && /^[a-z0-9]{2,6}$/i.test(card.set) ? card.set.toUpperCase() : '';
  const cn = typeof card.cn === 'string' && /^[\w★-]{1,10}$/.test(card.cn) ? card.cn : '';
  return `${qty} ${name}${set && cn ? ` (${set}) ${cn}` : ''}`;
}

/** Convierte la respuesta de Moxfield a las dos listas de texto que usa el modal de mazo. */
export function moxfieldToText(json) {
  const lines = (board) => boardEntries(json, board).map(entryLine).filter(Boolean);
  const commanders = lines('commanders');
  const main = [...lines('companions'), ...lines('mainboard')];
  if (!commanders.length && !main.length) throw new ImportError('El mazo de Moxfield está vacío o no se pudo leer');
  return {
    name: String(json?.name ?? 'Mazo de Moxfield').slice(0, 80),
    commandersText: commanders.join('\n'),
    listText: main.join('\n'),
  };
}

export async function importMoxfield(input, { userAgent = process.env.MOXFIELD_USER_AGENT, fetchImpl = fetch } = {}) {
  if (!userAgent) {
    throw new ImportError(
      'La importación desde Moxfield está desactivada hasta tener su autorización. Mientras tanto, en Moxfield usa Exportar → Copiar texto y pégalo aquí.',
      501,
    );
  }
  const id = parseMoxfieldUrl(input);
  const res = await fetchImpl(`https://api2.moxfield.com/v3/decks/all/${encodeURIComponent(id)}`, {
    headers: { 'User-Agent': userAgent, Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 404) throw new ImportError('No encontré ese mazo. ¿Es público?', 404);
  if (res.status === 403 || res.status === 429) throw new ImportError('Moxfield rechazó la consulta; intenta más tarde.', 502);
  if (!res.ok) throw new ImportError(`Moxfield respondió ${res.status}`, 502);
  return moxfieldToText(await res.json());
}
