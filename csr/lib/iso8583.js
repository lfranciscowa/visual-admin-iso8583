// csr/lib/iso8583.js
// ============================================================================
//  Encoder ISO 8583 para el switch FIRST-SWITCH / TranRed (canal Wifi 34025).
//
//  Wire format CONFIRMADO mediante análisis byte-por-byte de TRALOG402:
//
//    LOTR    : 2 bytes binario big-endian (longitud del cuerpo)
//    TPDU    : 5 bytes BCD packed = 10 dígitos (FIJO: 60 00 50 01 00)
//    MTI     : 2 bytes BCD packed = 4 dígitos (ej. 0200)
//    Bitmap  : 8 bytes binario (primario; secundario solo si DE > 64)
//    Campos  : según bitmap, en orden ascendente
//
//  Encoding por tipo de campo:
//    n (numérico fijo)    : BCD packed, 2 dígitos por byte, padded con ceros
//    LLVAR  (DE 2, 32, 35): 1 byte BCD len + ceil(N/2) bytes BCD/datos
//    LLLVAR (DE 47, 48,
//            55, 56, 57,  : 2 bytes BCD len ("0033" -> 0x00 0x33) + N bytes
//            62, 63)
//    an (alfanum fijo)    : ASCII (sin EBCDIC; el listener no traduce)
//    ASCII en LLLVAR      : Bytes ASCII directos (DE 47, 48, 56, 57, 62, 63)
//    Binario en LLLVAR    : Bytes binarios (DE 55 — datos EMV TLV)
//
//  IMPORTANTE — DE 49 (Currency): el switch lo agrega internamente.
//  NO debe viajar desde el POS (no incluir en bitmap).
// ============================================================================

'use strict';

// TPDU fijo confirmado por el equipo
const DEFAULT_TPDU = Buffer.from([0x60, 0x00, 0x50, 0x01, 0x00]);

// Tipos de cuenta para DE 3 (no es Processing Code estándar ISO en este switch)
const ACCOUNT_TYPES = {
  '000000': 'Cuenta principal',
  '001000': 'Ahorro',
  '002000': 'Corriente',
  '003000': 'Crédito',
};

// Definición de campos validada contra trama real de TRALOG402
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
  22: { type: 'n',      length: 4,   name: 'POS entry mode' },
  23: { type: 'n',      length: 4,   name: 'Card seq number' },
  24: { type: 'n',      length: 4,   name: 'Function code / NII' },
  25: { type: 'n',      length: 4,   name: 'POS condition code' },
  32: { type: 'n',      length: 4,   name: 'Acquirer ID' },
  35: { type: 'LLVAR',  maxLen: 37,  name: 'Track 2', allowSep: true },
  37: { type: 'an',     length: 12,  name: 'Retrieval ref nbr' },
  38: { type: 'an',     length: 6,   name: 'Auth ID' },
  39: { type: 'an',     length: 2,   name: 'Response code' },
  41: { type: 'an',     length: 8,   name: 'Terminal ID' },
  42: { type: 'an',     length: 15,  name: 'Merchant ID' },
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
// BCD packing
//   '0123' -> Buffer<0x01, 0x23>
//   Para track 2 con allowSep: '=' o 'D' -> nibble D
// ----------------------------------------------------------------------------
function bcdPack(digits, expectedBytes, allowSep = false) {
  let s = String(digits);
  if (allowSep) s = s.replace(/=/g, 'D');
  if (s.length % 2 !== 0) s = s + '0'; // pad con cero al final si es impar
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
// Bitmap primario (8 bytes) + secundario (8 bytes si hay DE > 64)
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
// Codificar un campo individual según FIELD_DEF
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
    // Numéricos BCD: padding a la IZQUIERDA, hasta número par de nibbles.
    // Ej. n3 "051" -> 4 nibbles "0051" -> 2 bytes 0x00 0x51
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
      // PAN, Acquirer, Track 2: BCD packed (con separador para track 2)
      dataBytes = bcdPack(v, Math.ceil(v.length / 2), def.allowSep);
    } else {
      dataBytes = Buffer.from(v, 'ascii');
    }
    return Buffer.concat([lenByte, dataBytes]);
  }

  if (def.type === 'LLLVAR') {
    // 2 bytes BCD len: "033" -> "0033" -> 0x00 0x33
    if (v.length > def.maxLen) {
      throw new Error(`DE ${de} excede ${def.maxLen} chars`);
    }

    let dataBytes, lenForHeader;

    if (def.binaryData) {
      // DE 55 — input es hex string, datos son binarios
      if (v.length % 2 !== 0) {
        throw new Error(`DE ${de} (binario): hex string debe tener longitud par`);
      }
      dataBytes    = Buffer.from(v, 'hex');
      lenForHeader = dataBytes.length;
    } else {
      dataBytes    = Buffer.from(v, 'ascii');
      lenForHeader = dataBytes.length;
    }

    // Longitud en 4 dígitos BCD (2 bytes)
    const lenStr   = lenForHeader.toString().padStart(4, '0');
    const lenBytes = bcdPack(lenStr, 2);

    return Buffer.concat([lenBytes, dataBytes]);
  }

  throw new Error(`Tipo no soportado: ${def.type}`);
}

// ----------------------------------------------------------------------------
// Construir mensaje completo
//   opts = { mti, fields: { 2: '...', 4: '...', ... } }
//   El TPDU se inserta automáticamente con el valor fijo.
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

  // LOTR: 2 bytes big-endian con la longitud del cuerpo
  const lenBuf = Buffer.alloc(2);
  lenBuf.writeUInt16BE(body.length, 0);

  return Buffer.concat([lenBuf, body]);
}

// ----------------------------------------------------------------------------
// Parser básico de respuesta para mostrar en el simulador
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

  // ── Extraer DE 39 (Response Code) si está presente ────────────
  // Este parseo asume el mismo formato del request (BCD/ASCII según FIELD_DEF)
  // Recorremos los DEs en orden y vamos leyendo bytes según FIELD_DEF
  if (presentDEs.includes(39)) {
    try {
      let offset = 17;  // Después del bitmap
      const fields = {};

      for (const de of presentDEs) {
        const def = FIELD_DEF[de];
        if (!def) {
          // No conocemos este DE, abortamos parseo
          break;
        }

        if (def.type === 'n') {
          const bytes = Math.ceil(def.length / 2);
          const slice = buf.slice(offset, offset + bytes);
          fields[de] = bcdUnpack(slice, def.length);
          offset += bytes;
        } else if (def.type === 'an') {
          const slice = buf.slice(offset, offset + def.length);
          fields[de] = slice.toString('ascii');
          offset += def.length;
        } else if (def.type === 'LLVAR') {
          const lenStr = bcdUnpack(buf.slice(offset, offset + 1), 2);
          const dataLen = parseInt(lenStr, 10);
          offset += 1;
          if (de === 2 || de === 32 || de === 35) {
            const bytes = Math.ceil(dataLen / 2);
            const slice = buf.slice(offset, offset + bytes);
            let unpacked = bcdUnpack(slice, bytes * 2);
            if (def.allowSep) unpacked = unpacked.replace(/D/g, '=');
            fields[de] = unpacked.substr(0, dataLen);
            offset += bytes;
          } else {
            fields[de] = buf.slice(offset, offset + dataLen).toString('ascii');
            offset += dataLen;
          }
        } else if (def.type === 'LLLVAR') {
          const lenStr = bcdUnpack(buf.slice(offset, offset + 2), 4);
          const dataLen = parseInt(lenStr, 10);
          offset += 2;
          if (def.binaryData) {
            fields[de] = buf.slice(offset, offset + dataLen).toString('hex').toUpperCase();
          } else {
            fields[de] = buf.slice(offset, offset + dataLen).toString('ascii');
          }
          offset += dataLen;
        }
      }

      out.fields = fields;

      // Atajos para los DEs más importantes
      if (fields[39]) {
        out.responseCode = fields[39];
        out.responseMsg  = describeResponseCode(fields[39]);
      }
      if (fields[38]) out.authCode = fields[38];
      if (fields[37]) out.retrievalRef = fields[37];
    } catch (err) {
      out.parseError = err.message;
    }
  }

  return out;
}

// Diccionario de códigos de respuesta ISO 8583 más comunes
function describeResponseCode(code) {
  const map = {
    '00': '✅ Aprobada',
    '01': 'Referirse al emisor',
    '03': 'Comercio inválido',
    '04': 'Capturar tarjeta',
    '05': 'Denegada',
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
  return map[code] || `Código ${code}`;
}

module.exports = {
  buildMessage,
  parseResponse,
  FIELD_DEF,
  ACCOUNT_TYPES,
  DEFAULT_TPDU,
  bcdPack,
  bcdUnpack,
};

