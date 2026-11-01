// Inicio de sesión con Google (OAuth 2.0 / OpenID Connect, flujo con código + PKCE).
// Requiere GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET de un cliente OAuth "Aplicación web"
// creado en Google Cloud Console, con el redirect URI .../api/auth/google/callback.
import { randomBytes, createHash } from 'node:crypto';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const STATE_TTL_MS = 10 * 60 * 1000;

export class GoogleAuthError extends Error {}

export function googleConfig(env = process.env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
  return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, redirectUri: env.GOOGLE_REDIRECT_URI || null };
}

/** Guarda en memoria el state y el verificador PKCE de cada intento de login. */
export function createGoogleFlow(config, { fetchImpl = fetch } = {}) {
  const pending = new Map(); // state -> { verifier, redirectUri, expires }

  const sweep = () => {
    const now = Date.now();
    for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
  };

  return {
    /** Devuelve la URL de Google a la que redirigir y el state para la cookie. */
    start(redirectUri) {
      sweep();
      const state = randomBytes(24).toString('base64url');
      const verifier = randomBytes(48).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const uri = config.redirectUri || redirectUri;
      pending.set(state, { verifier, redirectUri: uri, expires: Date.now() + STATE_TTL_MS });
      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: uri,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        prompt: 'select_account',
      });
      return { url: `${AUTH_URL}?${params}`, state };
    },

    /** Canjea el código por un id_token y devuelve el perfil verificado. */
    async finish({ code, state, cookieState }) {
      const entry = state && pending.get(state);
      pending.delete(state);
      if (!entry || entry.expires < Date.now()) throw new GoogleAuthError('El intento de inicio de sesión expiró. Vuelve a intentarlo.');
      if (!cookieState || cookieState !== state) throw new GoogleAuthError('El inicio de sesión no coincide con este navegador.');
      if (!code) throw new GoogleAuthError('Google no devolvió un código de autorización.');

      const res = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: entry.redirectUri,
          grant_type: 'authorization_code',
          code_verifier: entry.verifier,
        }),
        signal: AbortSignal.timeout(10000),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.id_token) throw new GoogleAuthError('Google rechazó el inicio de sesión.');
      return verifyIdTokenClaims(json.id_token, config.clientId);
    },
  };
}

/**
 * El id_token llega directo desde el endpoint de tokens de Google por TLS, así que
 * basta con validar sus campos (Google lo documenta así para este flujo).
 */
export function verifyIdTokenClaims(idToken, clientId, now = Date.now()) {
  const parts = String(idToken).split('.');
  if (parts.length !== 3) throw new GoogleAuthError('Token de Google inválido.');
  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new GoogleAuthError('Token de Google ilegible.');
  }
  if (!ISSUERS.has(claims.iss)) throw new GoogleAuthError('Emisor del token desconocido.');
  if (claims.aud !== clientId) throw new GoogleAuthError('El token no es para esta aplicación.');
  if (!claims.exp || claims.exp * 1000 < now) throw new GoogleAuthError('El token de Google expiró.');
  if (!claims.sub) throw new GoogleAuthError('El token no identifica a la cuenta.');
  if (claims.email && claims.email_verified === false) throw new GoogleAuthError('El correo de Google no está verificado.');
  return {
    sub: String(claims.sub),
    email: claims.email ? String(claims.email).slice(0, 200) : null,
    name: claims.name ? String(claims.name).slice(0, 60) : null,
    picture: typeof claims.picture === 'string' && claims.picture.startsWith('https://') ? claims.picture.slice(0, 500) : null,
  };
}
