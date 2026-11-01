// Parseo de listas de mazo (texto de Moxfield/Archidekt/MTGO) y resolución en Scryfall.

const SECTION_COMMANDER = /^(commanders?|comandantes?|command zone)\s*:?\s*(\(\d+\))?$/i;
const SECTION_MAIN = /^(deck|mazo|main(board)?|companion|compañero)\s*:?\s*(\(\d+\))?$/i;
const SECTION_SKIP = /^(sideboard|maybeboard|considering|tokens?|banco)\s*:?\s*(\(\d+\))?$/i;
const LINE = /^(?:(\d+)\s*x?\s+)?(.+?)(?:\s+\(([A-Za-z0-9]{2,6})\)(?:\s+([\w★-]+))?)?\s*$/;

/** Devuelve { commanders, cards } con entradas { qty, name, set, num }. */
export function parseDeckList(text, { commanderSection = false } = {}) {
  const out = { commanders: [], cards: [] };
  let section = commanderSection ? 'commander' : 'main';
  for (let raw of String(text).split(/\r?\n/)) {
    raw = raw.replace(/\s+\*[A-Z]+\*\s*$/, '') // marcas de foil *F* *E*
      .replace(/\s+\[[^\]]*\]\s*$/, '') // categorías de Archidekt [Ramp]
      .replace(/\s+\^[^^]*\^\s*$/, '')
      .replace(/\s+#\S.*$/, '') // etiquetas
      .trim();
    if (!raw || raw.startsWith('//') || raw.startsWith('#')) continue;
    if (SECTION_COMMANDER.test(raw)) { section = 'commander'; continue; }
    if (SECTION_MAIN.test(raw)) { section = 'main'; continue; }
    if (SECTION_SKIP.test(raw)) { section = 'skip'; continue; }
    if (section === 'skip') continue;
    const m = raw.match(LINE);
    if (!m) continue;
    const entry = { qty: Math.min(Number(m[1] ?? 1), 99), name: m[2].trim(), set: m[3]?.toLowerCase(), num: m[4] };
    (section === 'commander' ? out.commanders : out.cards).push(entry);
  }
  return out;
}

const frontName = (name) => name.split(' // ')[0].trim().toLowerCase();

function toCardData(card) {
  const faces = card.card_faces ?? [];
  const image = card.image_uris?.normal ?? faces[0]?.image_uris?.normal ?? null;
  const backImage = !card.image_uris && faces[1]?.image_uris?.normal ? faces[1].image_uris.normal : null;
  const tokens = (card.all_parts ?? [])
    .filter((part) => part.component === 'token' && part.id !== card.id)
    .map((part) => ({ name: part.name, id: part.id }));
  return { name: card.name, image, backImage, typeLine: card.type_line ?? '', scryfallId: card.id ?? null, tokens };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchCollection(identifiers) {
  const res = await fetch('https://api.scryfall.com/cards/collection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ identifiers }),
  });
  if (!res.ok) throw new Error(`Scryfall respondió ${res.status}`);
  return res.json();
}

/**
 * Resuelve entradas contra Scryfall. Devuelve { commanders, cards, notFound } con
 * cartas expandidas por cantidad, listas para enviar al servidor.
 */
export async function resolveDeck(parsed, onProgress = () => {}) {
  const all = [...parsed.commanders, ...parsed.cards];
  const keyOf = (e) => (e.set && e.num ? `${e.set}|${e.num}` : `n|${frontName(e.name)}`);
  const unique = new Map();
  for (const e of all) if (!unique.has(keyOf(e))) unique.set(keyOf(e), e);

  const found = new Map(); // key -> cardData
  const byName = new Map();
  const remember = (card) => {
    const data = toCardData(card);
    byName.set(card.name.toLowerCase(), data);
    for (const f of card.name.split(' // ')) byName.set(f.trim().toLowerCase(), data);
    if (card.set && card.collector_number) found.set(`${card.set}|${card.collector_number}`, data);
  };

  const run = async (entries, asName) => {
    for (let i = 0; i < entries.length; i += 75) {
      const chunk = entries.slice(i, i + 75);
      const ids = chunk.map((e) => (!asName && e.set && e.num ? { set: e.set, collector_number: e.num } : { name: e.name.split(' // ')[0] }));
      const json = await fetchCollection(ids);
      json.data.forEach(remember);
      onProgress(Math.min(i + 75, entries.length), entries.length);
      if (i + 75 < entries.length) await sleep(120);
    }
  };

  await run([...unique.values()], false);
  // Reintento por nombre para las que fallaron por edición/número.
  const missing = [...unique.values()].filter((e) => !found.get(keyOf(e)) && !byName.get(frontName(e.name)));
  const retry = missing.filter((e) => e.set && e.num);
  if (retry.length) await run(retry, true);

  const lookup = (e) => found.get(keyOf(e)) ?? byName.get(frontName(e.name)) ?? null;
  const notFound = [];
  const expand = (list) => list.flatMap((e) => {
    const data = lookup(e);
    if (!data) { notFound.push(e.name); return []; }
    return Array.from({ length: e.qty }, () => data);
  });
  return { commanders: expand(parsed.commanders), cards: expand(parsed.cards), notFound: [...new Set(notFound)] };
}

// ---------- Consultas sueltas a Scryfall (ficha de carta y tokens) ----------
const cache = new Map();
async function getJson(url) {
  if (cache.has(url)) return cache.get(url);
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Scryfall respondió ${res.status}`);
  const json = await res.json();
  cache.set(url, json);
  return json;
}

export const fetchCard = (id) => getJson(`https://api.scryfall.com/cards/${encodeURIComponent(id)}`);
export const fetchRulings = (id) => getJson(`https://api.scryfall.com/cards/${encodeURIComponent(id)}/rulings`).then((r) => r?.data ?? []);
export { toCardData };

/** Busca tokens por nombre; devuelve como máximo `limit` resultados con imagen. */
export async function searchTokens(query, limit = 24) {
  const q = `t:token ${query}`.trim();
  const json = await getJson(`https://api.scryfall.com/cards/search?unique=art&order=name&q=${encodeURIComponent(q)}`);
  return (json?.data ?? []).slice(0, limit).map(toCardData).filter((c) => c.image);
}
