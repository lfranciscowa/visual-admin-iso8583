// csr/lib/iso8583.js
// ============================================================================
//  Encoder/Parser ISO 8583 para el switch FIRST-SWITCH / TranRed.
//
//  Wire format CONFIRMADO mediante análisis byte-por-byte de TRALOG402:
//    LOTR    : 2 bytes binario big-endian
//    TPDU    : 5 bytes BCD packed (FIJO: 60 00 50 01 00)
//    MTI     : 2 bytes BCD packed = 4 dígitos
//    Bitmap  : 8 bytes binario
//    Campos  : según bitmap, en orden ascendente
// ============================================================================

'use strict';

const DEFAULT_TPDU = Buffer.from([0x60, 0x00, 0x50, 0x01, 0x00]);

const ACCOUNT_TYPES = {
  '000000': 'Cuenta principal',
  '001000': 'Ahorro',
  '002000': 'Corriente',
  '003000': 'Crédito',
};

// FIELD_DEF actualizado para Recarga (puerto 34026)
const FIELD_DEF = {
  2:  { type: 'LLVAR',  maxLen: 19,  name: 'PAN' },
  3:  { type: 'n',      length: 6,   name: 'Account type' },
  4:  { type: 'n',      length: 12,  name: 'Amount, transaction' },
  7:  { type: 'n',      length: 10,  name: 'Transmission DT (MMDDhhmmss)' },
  11: { type: 'n',      length: 6,   name: 'STAN' },
  12: { type: 'n',      length: 6,   name: 'Time, local (hhmmss)' },
  13: { type: 'n',      length: 4,   name: 'Date, local (MMDD)' },
  14: { type: 'n',      length: 4,   name: 'Card expiry (YYMM)' },
  18: { type: 'n',      length: 4,   name: 'Merchant category' },
  22: { type: 'n',      length: 4,   name: 'POS entry mode' },         // ← n4 (Recarga)
  23: { type: 'n',      length: 4,   name: 'Card seq number' },        // ← n4 (Recarga)
  24: { type: 'n',      length: 4,   name: 'Function code / NII' },    // ← n4 (Recarga)
  25: { type: 'n',      length: 4,   name: 'POS condition code' },     // ← n4 (Recarga)
  32: { type: 'n',      length: 4,   name: 'Acquirer ID' },            // ← n4 fijo (Recarga)
  35: { type: 'LLVAR',  maxLen: 37,  name: 'Track 2', allowSep: true },
  37: { type: 'an',     length: 12,  name: 'Retrieval ref nbr' },
  38: { type: 'an',     length: 6,   name: 'Auth ID' },
  39: { type: 'an',     length: 2,   name: 'Response code' },
  41: { type: 'an',     length: 8,   name: 'Terminal ID' },
  42: { type: 'an',     length: 15,  name: 'Merchant ID' },
  46: { type: 'LLLVAR', maxLen: 999, name: 'Additional info' },
  47: { type: 'LLLVAR', maxLen: 999, name: 'Application name' },
  48: { type: 'LLLVAR', maxLen: 999, name: 'Additional data' },
  55: { type: 'LLLVAR', maxLen: 999, name: 'EMV data', binaryData: true },
  56: { type: 'LLLVAR', maxLen: 999, name: 'Currency name' },
  57: { type: 'LLLVAR', maxLen: 999, name: 'Tax info' },
  62: { type: 'LLLVAR', maxLen: 999, name: 'Reserved private' },
  63: { type: 'LLLVAR', maxLen: 999, name: 'Reserved private' },
  70: { type: 'n',      length: 3,   name: 'Network mgmt code (0800)' },
};

// ----------------------------------------------------------------------------
// Diccionario de códigos de respuesta ISO 8583 (DE 39)
// ----------------------------------------------------------------------------
const RESPONSE_CODES = {
  '00': '✅ Aprobada',
  '01': 'Referirse al emisor',
  '03': 'Comercio inválido',
  '04': 'Capturar tarjeta',
  '05': '❌ Denegada',
  '12': 'Transacción inválida',
  '13': 'Monto inválido',
  '14': 'Tarjeta inválida',
  '30': 'Error de formato',
  '41': 'Tarjeta extraviada',
  '43': 'Tarjeta robada',
  '51': 'Fondos insuficientes',
  '54': 'Tarjeta vencida',
  '55': 'PIN incorrecto',
  '57': 'Transacción no permitida',
  '58': 'Terminal no autorizada',
  '61': 'Excede límite de retiro',
  '62': 'Tarjeta restringida',
  '65': 'Excede frecuencia de retiro',
  '75': 'PIN bloqueado',
  '76': 'Cuenta no encontrada',
  '78': 'Cuenta inválida',
  '91': '⚠️ Switch fuera de servicio',
  '92': 'Ruta no encontrada',
  '94': 'Transacción duplicada',
  '96': 'Mal funcionamiento del sistema',
};

function describeResponseCode(code) {
  return RESPONSE_CODES[code] || `Código ${code}`;
}

// ----------------------------------------------------------------------------
// BCD packing
// ----------------------------------------------------------------------------
function bcdPack(digits, expectedBytes, allowSep = false) {
  let s = String(digits);
  if (allowSep) s = s.replace(/=/g, 'D');
  if (s.length % 2 !== 0) s = s + '0';
  const buf = Buffer.alloc(expectedBytes, 0);
  for (let i = 0; i < s.length && i / 2 < expectedBytes; i += 2) {
    buf[i / 2] = parseInt(s.substr(i, 2), 16);
  }
  return buf;
}

function bcdUnpack(buf, totalDigits) {
  let s = '';
  for (const b of buf) {
    s += ((b >> 4) & 0xF).toString(16) + (b & 0xF).toString(16);
  }
  return s.toUpperCase().substr(0, totalDigits);
}

// ----------------------------------------------------------------------------
// Bitmap
// ----------------------------------------------------------------------------
function buildBitmap(des) {
  const hasSecondary = des.some(d => d > 64);
  let active = des.slice();
  if (hasSecondary && !active.includes(1)) active.push(1);
  const bitmap = Buffer.alloc(hasSecondary ? 16 : 8, 0);
  for (const d of active) {
    if (d < 1 || d > 128) continue;
    const idx = (d - 1) >> 3;
    const bit = 7 - ((d - 1) & 7);
    bitmap[idx] |= (1 << bit);
  }
  return bitmap;
}

// ----------------------------------------------------------------------------
// Codificar campo individual
// ----------------------------------------------------------------------------
function encodeField(de, value) {
  const def = FIELD_DEF[de];
  if (!def) throw new Error(`DE ${de} no definido en FIELD_DEF`);
  const v = String(value);

  if (def.type === 'n') {
    if (v.length > def.length) {
      throw new Error(`DE ${de} (${def.name}) excede ${def.length} dígitos: "${v}"`);
    }
    if (!/^\d*$/.test(v)) {
      throw new Error(`DE ${de} (${def.name}) debe ser numérico: "${v}"`);
    }
    const expectedBytes   = Math.ceil(def.length / 2);
    const expectedNibbles = expectedBytes * 2;
    const padded = v.padStart(expectedNibbles, '0');
    return bcdPack(padded, expectedBytes);
  }

  if (def.type === 'an') {
    const padded = v.padEnd(def.length, ' ').slice(0, def.length);
    return Buffer.from(padded, 'ascii');
  }

  if (def.type === 'LLVAR') {
    if (v.length > def.maxLen) {
      throw new Error(`DE ${de} excede ${def.maxLen} chars`);
    }
    const lenStr  = v.length.toString().padStart(2, '0');
    const lenByte = bcdPack(lenStr, 1);

    let dataBytes;
    if (de === 2 || de === 32 || de === 35) {
      dataBytes = bcdPack(v, Math.ceil(v.length / 2), def.allowSep);
    } else {
      dataBytes = Buffer.from(v, 'ascii');
    }
    return Buffer.concat([lenByte, dataBytes]);
  }

  if (def.type === 'LLLVAR') {
    if (v.length > def.maxLen) {
      throw new Error(`DE ${de} excede ${def.maxLen} chars`);
    }

    let dataBytes, lenForHeader;

    if (def.binaryData) {
      if (v.length % 2 !== 0) {
        throw new Error(`DE ${de} (binario): hex string debe tener longitud par`);
      }
      dataBytes    = Buffer.from(v, 'hex');
      lenForHeader = dataBytes.length;
    } else {
      dataBytes    = Buffer.from(v, 'ascii');
      lenForHeader = dataBytes.length;
    }

    const lenStr   = lenForHeader.toString().padStart(4, '0');
    const lenBytes = bcdPack(lenStr, 2);

    return Buffer.concat([lenBytes, dataBytes]);
  }

  throw new Error(`Tipo no soportado: ${def.type}`);
}

// ----------------------------------------------------------------------------
// Construir mensaje completo
// ----------------------------------------------------------------------------
function buildMessage(opts) {
  const { mti, fields } = opts;
  if (!mti || !/^\d{4}$/.test(mti)) {
    throw new Error(`MTI inválido: "${mti}" (debe ser 4 dígitos)`);
  }

  const sortedDEs = Object.keys(fields)
    .map(Number)
    .filter(n => fields[n] !== undefined && fields[n] !== '' && fields[n] !== null)
    .sort((a, b) => a - b);

  const tpduBuf   = DEFAULT_TPDU;
  const mtiBuf    = bcdPack(mti, 2);
  const bitmapBuf = buildBitmap(sortedDEs);
  const fieldBufs = sortedDEs.map(de => encodeField(de, fields[de]));

  const body = Buffer.concat([tpduBuf, mtiBuf, bitmapBuf, ...fieldBufs]);

  const lenBuf = Buffer.alloc(2);
  lenBuf.writeUInt16BE(body.length, 0);

  return Buffer.concat([lenBuf, body]);
}

// ----------------------------------------------------------------------------
// Parser de respuesta — extrae DE 39 y otros campos clave
// ----------------------------------------------------------------------------
function parseResponse(buf) {
  if (buf.length < 17) {
    return { error: 'Respuesta demasiado corta', rawHex: buf.toString('hex').toUpperCase() };
  }
  const out = { rawHex: buf.toString('hex').toUpperCase() };
  out.declaredLen = buf.readUInt16BE(0);
  out.tpdu        = buf.slice(2, 7).toString('hex').toUpperCase();
  out.mti         = bcdUnpack(buf.slice(7, 9), 4);

  const primary  = buf.slice(9, 17);
  out.bitmapHex  = primary.toString('hex').toUpperCase();
  out.bitmapBin  = [...primary].map(b => b.toString(2).padStart(8, '0')).join(' ');
  out.dataHex    = buf.slice(17).toString('hex').toUpperCase();

  const presentDEs = [];
  for (let i = 0; i < 64; i++) {
    const byteIdx = i >> 3;
    const bitIdx  = 7 - (i & 7);
    if (primary[byteIdx] & (1 << bitIdx)) presentDEs.push(i + 1);
  }
  out.presentDEs = presentDEs;

  // Parseo best-effort de los campos de la respuesta
  try {
    let offset = 17;
    const fields = {};

    for (const de of presentDEs) {
      const def = FIELD_DEF[de];
      if (!def) {
        // DE no conocido, abortamos parseo de campos
        out.parseWarning = `DE ${de} no conocido, parseo abortado en offset ${offset}`;
        break;
      }

      if (def.type === 'n') {
        const bytes = Math.ceil(def.length / 2);
        if (offset + bytes > buf.length) break;
        const slice = buf.slice(offset, offset + bytes);
        fields[de] = bcdUnpack(slice, def.length);
        offset += bytes;
      } else if (def.type === 'an') {
        if (offset + def.length > buf.length) break;
        const slice = buf.slice(offset, offset + def.length);
        fields[de] = slice.toString('ascii');
        offset += def.length;
      } else if (def.type === 'LLVAR') {
        if (offset + 1 > buf.length) break;
        const lenStr = bcdUnpack(buf.slice(offset, offset + 1), 2);
        const dataLen = parseInt(lenStr, 10);
        offset += 1;
        if (de === 2 || de === 32 || de === 35) {
          const bytes = Math.ceil(dataLen / 2);
          if (offset + bytes > buf.length) break;
          const slice = buf.slice(offset, offset + bytes);
          let unpacked = bcdUnpack(slice, bytes * 2);
          if (def.allowSep) unpacked = unpacked.replace(/D/gi, '=');
          fields[de] = unpacked.substr(0, dataLen);
          offset += bytes;
        } else {
          if (offset + dataLen > buf.length) break;
          fields[de] = buf.slice(offset, offset + dataLen).toString('ascii');
          offset += dataLen;
        }
      } else if (def.type === 'LLLVAR') {
        if (offset + 2 > buf.length) break;
        const lenStr = bcdUnpack(buf.slice(offset, offset + 2), 4);
        const dataLen = parseInt(lenStr, 10);
        offset += 2;
        if (offset + dataLen > buf.length) break;
        if (def.binaryData) {
          fields[de] = buf.slice(offset, offset + dataLen).toString('hex').toUpperCase();
        } else {
          fields[de] = buf.slice(offset, offset + dataLen).toString('ascii');
        }
        offset += dataLen;
      }
    }

    out.fields = fields;

    if (fields[39]) {
      out.responseCode = fields[39];
      out.responseMsg  = describeResponseCode(fields[39]);
    }
    if (fields[38]) out.authCode     = fields[38];
    if (fields[37]) out.retrievalRef = fields[37];
  } catch (err) {
    out.parseError = err.message;
  }

  return out;
}

module.exports = {
  buildMessage,
  parseResponse,
  FIELD_DEF,
  ACCOUNT_TYPES,
  RESPONSE_CODES,
  DEFAULT_TPDU,
  bcdPack,
  bcdUnpack,
  describeResponseCode,
};

