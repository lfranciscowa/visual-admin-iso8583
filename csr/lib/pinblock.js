// csr/lib/pinblock.js
// ============================================================================
//  PIN block ISO 9564-1 + cifrado 3DES, para enviar DE52 al switch/simulador.
//
//  Algoritmo IDÉNTICO al del simulador ISO 8583 (lib/crypto8583.js) para que
//  el PIN block que se genera aquí pueda descifrarse y validarse allá:
//    - Formato 0 (ANSI X9.8): PIN field XOR PAN field.
//    - 3DES-ECB (des-ede3) de un bloque de 8 bytes, sin padding.
//    - Llave 16 bytes (2-key) expandida a 24 (K1K2K1).
// ============================================================================

'use strict';

const crypto = require('crypto');

function hexToBuf(hex) {
  const clean = String(hex).replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2 !== 0) throw new Error('hex de longitud impar');
  return Buffer.from(clean, 'hex');
}

function xorHex(a, b) {
  const ba = hexToBuf(a), bb = hexToBuf(b);
  const n = Math.min(ba.length, bb.length);
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) out[i] = ba[i] ^ bb[i];
  return out.toString('hex').toUpperCase();
}

function normalizeKey(keyHex) {
  const buf = hexToBuf(keyHex);
  if (buf.length === 24) return buf;
  if (buf.length === 16) return Buffer.concat([buf, buf.slice(0, 8)]);  // K1K2K1
  if (buf.length === 8)  return Buffer.concat([buf, buf, buf]);         // K1K1K1
  throw new Error(`longitud de llave inválida: ${buf.length} bytes (esperado 8, 16 o 24)`);
}

function tdesEncryptBlock(dataBuf, keyHex) {
  const key = normalizeKey(keyHex);
  const c = crypto.createCipheriv('des-ede3', key, null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(dataBuf), c.final()]);
}

// PIN block claro ISO 9564-1 formato 0 (ANSI X9.8)
function buildClearPinBlock0(pin, pan) {
  pin = String(pin).replace(/\D/g, '');
  if (pin.length < 4 || pin.length > 12) throw new Error('PIN debe tener 4 a 12 dígitos');
  const L = pin.length.toString(16).toUpperCase();

  let pinField = '0' + L + pin;
  while (pinField.length < 16) pinField += 'F';
  pinField = pinField.slice(0, 16);

  const panDigits = String(pan).replace(/\D/g, '');
  if (panDigits.length < 13) throw new Error('PAN demasiado corto para formato 0');
  const pan12 = panDigits.slice(0, -1).slice(-12);   // 12 dígitos sin el verificador
  const panField = '0000' + pan12;

  return xorHex(pinField, panField);                 // 16 hex = 8 bytes claros
}

// Cifra el PIN → devuelve el PIN block cifrado (hex, 16 chars) que va en DE52.
function encryptPinBlock(pin, pan, keyHex) {
  const clear = buildClearPinBlock0(pin, pan);
  const enc = tdesEncryptBlock(hexToBuf(clear), keyHex);
  return enc.toString('hex').toUpperCase();
}

module.exports = { encryptPinBlock, buildClearPinBlock0 };
