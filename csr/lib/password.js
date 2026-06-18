// csr/lib/password.js
// Hashing de contraseñas con scrypt (módulo nativo de Node, sin dependencias).
// Formato almacenado:  scrypt$<salt_hex>$<hash_hex>
'use strict';
const crypto = require('crypto');

const PREFIX = 'scrypt$';
const KEYLEN = 64;

/** Genera el hash seguro de una contraseña en claro. */
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const dk = crypto.scryptSync(String(plain), salt, KEYLEN).toString('hex');
  return `${PREFIX}${salt}$${dk}`;
}

/** ¿El valor almacenado ya está hasheado (formato scrypt)? */
function isHashed(stored) {
  return typeof stored === 'string' && stored.startsWith(PREFIX);
}

/**
 * Verifica una contraseña contra el valor almacenado.
 * Soporta legado en texto plano para permitir migración progresiva.
 * @returns {{ok:boolean, legacy:boolean}}
 */
function verifyPassword(plain, stored) {
  if (!isHashed(stored)) {
    // Valor antiguo en texto plano (se re-hashea al primer login exitoso).
    return { ok: stored === plain, legacy: true };
  }
  const parts = stored.split('$'); // ['scrypt', salt, hash]
  const salt = parts[1];
  const key = parts[2] || '';
  const dk = crypto.scryptSync(String(plain), salt, KEYLEN).toString('hex');
  const a = Buffer.from(dk, 'hex');
  const b = Buffer.from(key, 'hex');
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return { ok, legacy: false };
}

/** Genera una contraseña temporal fuerte (no solo hex). */
function generarClaveTemporal(longitud = 12) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%';
  let out = '';
  const bytes = crypto.randomBytes(longitud);
  for (let i = 0; i < longitud; i++) out += abc[bytes[i] % abc.length];
  return out;
}

module.exports = { hashPassword, isHashed, verifyPassword, generarClaveTemporal };
