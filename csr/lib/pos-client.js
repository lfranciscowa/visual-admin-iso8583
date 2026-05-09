// csr/lib/pos-client.js
// ============================================================================
//  Cliente POS con DOS MODOS de operación:
//
//  1. TCP directo (default)
//     Cuando NO está definida la variable POS_BRIDGE_URL.
//     Abre socket TCP a host:port y manda el buffer.
//     Lee respuesta con framing por header LOTR de 2 bytes BE.
//     Útil para correr local con VPN activa.
//
//  2. HTTP Bridge
//     Cuando POS_BRIDGE_URL apunta a un relay HTTP (ej. el endpoint
//     /pos-tcp del relay.js).
//     Manda el buffer codificado en hex por HTTP, recibe respuesta hex.
//     Útil cuando se corre en Render y no hay acceso TCP a la red interna.
//
//  Ambos modos exponen el mismo método sendMessage(...) y devuelven el
//  mismo formato { response: Buffer, elapsedMs: number }.
// ============================================================================

'use strict';

const net   = require('net');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// Si está definida, todas las llamadas van por bridge HTTP
const BRIDGE_URL = process.env.POS_BRIDGE_URL || null;

if (BRIDGE_URL) {
  console.log(`🌉 POS-Client modo BRIDGE → ${BRIDGE_URL}`);
} else {
  console.log('🔌 POS-Client modo TCP DIRECTO');
}

/**
 * Envía un mensaje ISO 8583 (con LOTR ya incluido) y espera respuesta.
 *
 * @param {Object} opts
 * @param {string} opts.host          IP del switch (ignorado en modo bridge)
 * @param {number} opts.port          Puerto del switch (ignorado en modo bridge)
 * @param {Buffer} opts.message       Buffer completo (LOTR + cuerpo)
 * @param {number} [opts.timeoutMs]   Timeout en ms (default 10000)
 * @returns {Promise<{response: Buffer, elapsedMs: number}>}
 */
function sendMessage(opts) {
  if (BRIDGE_URL) {
    return sendViaBridge(opts);
  }
  return sendViaTcp(opts);
}

// ----------------------------------------------------------------------------
// MODO 1 — TCP directo
// ----------------------------------------------------------------------------
function sendViaTcp({ host, port, message, timeoutMs = 10000 }) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let received    = Buffer.alloc(0);
    let expectedLen = -1;
    let resolved    = false;
    const t0 = Date.now();

    console.log(`🔌 [TCP] Abriendo conexión a ${host}:${port}`);
    console.log(`🔌 [TCP] Mensaje a enviar: ${message.length}b`);

    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      console.log(`⏱️  [TCP] TIMEOUT alcanzado (${timeoutMs}ms)`);
      console.log(`⏱️  [TCP] Bytes acumulados al timeout: ${received.length}b`);
      if (received.length > 0) {
        console.log(`⏱️  [TCP] Hex acumulado: ${received.toString('hex').toUpperCase()}`);
      }
      socket.destroy();
      reject(new Error(`Timeout después de ${timeoutMs}ms (host=${host}:${port})`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      try { socket.end(); } catch {}
    };

    socket.connect(port, host, () => {
      console.log(`🔌 [TCP] Socket CONECTADO a ${host}:${port}`);
      try {
        socket.write(message);
        console.log(`📤 [TCP] Bytes ENVIADOS: ${message.length}b`);
      } catch (err) {
        if (resolved) return;
        resolved = true;
        cleanup();
        reject(err);
      }
    });

    socket.on('data', (chunk) => {
      console.log(`📥 [TCP] CHUNK recibido (${chunk.length}b): ${chunk.toString('hex').toUpperCase()}`);
      received = Buffer.concat([received, chunk]);
      console.log(`📥 [TCP] Total acumulado: ${received.length}b`);

      if (expectedLen < 0 && received.length >= 2) {
        expectedLen = received.readUInt16BE(0);
        console.log(`📐 [TCP] LOTR leído (BE): ${expectedLen} bytes esperados (total con LOTR=${expectedLen + 2}b)`);
      }
      if (expectedLen >= 0 && received.length >= 2 + expectedLen) {
        if (resolved) return;
        resolved = true;
        console.log(`✅ [TCP] Respuesta COMPLETA recibida en ${Date.now() - t0}ms`);
        cleanup();
        resolve({
          response:  received.slice(0, 2 + expectedLen),
          elapsedMs: Date.now() - t0,
        });
      }
    });

    socket.on('error', (err) => {
      console.log(`❌ [TCP] ERROR del socket: ${err.message}`);
      if (resolved) return;
      resolved = true;
      cleanup();
      reject(new Error(`Socket error (${host}:${port}): ${err.message}`));
    });

    socket.on('close', (hadError) => {
      console.log(`🔒 [TCP] Socket CERRADO (hadError=${hadError})`);
      console.log(`🔒 [TCP] Bytes totales recibidos: ${received.length}b`);
      if (received.length > 0) {
        console.log(`🔒 [TCP] Hex final: ${received.toString('hex').toUpperCase()}`);
      }
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (received.length === 0) {
        reject(new Error('Conexión cerrada sin respuesta del switch'));
      } else if (expectedLen < 0) {
        reject(new Error(`Conexión cerrada con respuesta incompleta (${received.length} bytes, sin LOTR)`));
      } else if (received.length < 2 + expectedLen) {
        reject(new Error(`Respuesta truncada: esperaba ${2 + expectedLen}b, recibí ${received.length}b`));
      } else {
        resolve({
          response:  received.slice(0, 2 + expectedLen),
          elapsedMs: Date.now() - t0,
        });
      }
    });
  });
}
// ----------------------------------------------------------------------------
// MODO 2 — HTTP Bridge
// Manda el mensaje al endpoint /pos-tcp del relay como hex.
// El relay abre TCP local hacia el switch, recibe respuesta y la
// devuelve también en hex. Acá la convertimos de vuelta a Buffer.
// ----------------------------------------------------------------------------
async function sendViaBridge({ host, port, message, timeoutMs = 10000 }) {
  const t0 = Date.now();
  const hexMessage = message.toString('hex').toUpperCase();

  // Adapter timeout: el relay tiene su propio timeout, pero le sumamos
  // un margen razonable para latencia de red (Render → Cloudflare → PC).
  const httpTimeout = timeoutMs + 5000;

  // AbortController para limitar tiempo de la petición HTTP
  const controller = new AbortController();
  const httpTimer  = setTimeout(() => controller.abort(), httpTimeout);

  try {
    const res = await fetch(BRIDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hexMessage,
        host,
        port,
        timeoutMs,
      }),
      signal: controller.signal,
    });

    clearTimeout(httpTimer);

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Bridge HTTP ${res.status}: ${errBody.substring(0, 200)}`);
    }

    const data = await res.json();
    if (!data.ok) {
      throw new Error(`Bridge respondió error: ${data.error || 'desconocido'}`);
    }
    if (!data.responseHex) {
      throw new Error('Bridge no devolvió responseHex');
    }

    const responseBuffer = Buffer.from(data.responseHex, 'hex');

    return {
      response:  responseBuffer,
      // Tiempo elapsed total (incluye latencia HTTP + TCP del relay)
      elapsedMs: Date.now() - t0,
    };
  } catch (err) {
    clearTimeout(httpTimer);
    if (err.name === 'AbortError') {
      throw new Error(`Bridge timeout después de ${httpTimeout}ms`);
    }
    throw new Error(`Bridge error: ${err.message}`);
  }
}

module.exports = { sendMessage };
