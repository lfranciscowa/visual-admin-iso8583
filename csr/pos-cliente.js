// csr/lib/pos-client.js
// ============================================================================
//  Cliente TCP para enviar mensajes ISO 8583 al switch AS/400 (puerto 34025
//  para canal Wifi) y leer la respuesta con framing por header LOTR de 2
//  bytes big-endian.
//
//  El listener AISSER4025 cierra la conexión después de cada respuesta,
//  por lo que cada llamada abre un socket nuevo (one-shot).
// ============================================================================

'use strict';

const net = require('net');

/**
 * Envia un Buffer ISO 8583 (con LOTR ya incluido) y espera la respuesta.
 *
 * @param {Object} opts
 * @param {string} opts.host          IP del AS/400 (ej. '172.23.12.2')
 * @param {number} opts.port          Puerto del listener (ej. 34025)
 * @param {Buffer} opts.message       Buffer completo (LOTR + cuerpo)
 * @param {number} [opts.timeoutMs]   Timeout en ms (default 10000)
 * @returns {Promise<{response: Buffer, elapsedMs: number}>}
 */
function sendMessage({ host, port, message, timeoutMs = 10000 }) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let received   = Buffer.alloc(0);
    let expectedLen = -1;
    let resolved    = false;
    const t0 = Date.now();

    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      reject(new Error(`Timeout después de ${timeoutMs}ms (host=${host}:${port})`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      try { socket.end(); } catch {}
    };

    socket.connect(port, host, () => {
      try {
        socket.write(message);
      } catch (err) {
        if (resolved) return;
        resolved = true;
        cleanup();
        reject(err);
      }
    });

    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk]);

      // Primer chunk: leer LOTR (2 bytes BE)
      if (expectedLen < 0 && received.length >= 2) {
        expectedLen = received.readUInt16BE(0);
      }

      // Si ya tenemos LOTR + cuerpo completo, resolver
      if (expectedLen >= 0 && received.length >= 2 + expectedLen) {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve({
          response:  received.slice(0, 2 + expectedLen),
          elapsedMs: Date.now() - t0,
        });
      }
    });

    socket.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      reject(new Error(`Socket error (${host}:${port}): ${err.message}`));
    });

    socket.on('close', () => {
      // Si se cerró sin haber recibido lo declarado, reportar lo que hay
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
        // Caso raro: cerró exactamente con la respuesta justa
        resolve({
          response:  received.slice(0, 2 + expectedLen),
          elapsedMs: Date.now() - t0,
        });
      }
    });
  });
}

module.exports = { sendMessage };
