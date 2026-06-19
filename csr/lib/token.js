// csr/lib/token.js
// Tokens de sesión firmados con HMAC-SHA256 (módulo nativo, sin dependencias).
// Formato: base64url(payload).base64url(firma)   — estilo JWT minimalista.
'use strict';
const crypto = require('crypto');

// Secreto de firma. En producción DEFINIR AUTH_SECRET (Render / .env).
// Si no existe, se genera uno al azar al arrancar (los tokens no sobreviven
// reinicios → los usuarios tendrían que volver a entrar).
const SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.AUTH_SECRET) {
  console.warn('⚠️  AUTH_SECRET no definido: usando secreto temporal (define AUTH_SECRET en producción).');
}

// Duración de la sesión: 8 horas.
const TTL_MS = 8 * 60 * 60 * 1000;

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function firmar(data) {
  return b64url(crypto.createHmac('sha256', SECRET).update(data).digest());
}

/** Genera un token para un usuario. */
function generarToken({ username, rol }) {
  const payload = { u: username, r: rol, exp: Date.now() + TTL_MS };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${firmar(body)}`;
}

/** Verifica un token. Devuelve el payload si es válido, o null. */
function verificarToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  // Comparación en tiempo constante de la firma.
  const esperado = firmar(body);
  const a = Buffer.from(sig || '');
  const b = Buffer.from(esperado);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
    if (!payload.exp || Date.now() > payload.exp) return null; // expirado
    return payload;
  } catch { return null; }
}

module.exports = { generarToken, verificarToken, TTL_MS };
