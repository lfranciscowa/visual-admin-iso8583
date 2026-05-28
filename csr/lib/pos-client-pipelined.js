// csr/lib/pos-client-pipelined.js
// ============================================================================
//  Cliente POS con conexión TCP persistente y pipelining.
//
//  Diferencia clave vs pos-client.js:
//    - pos-client.js: abre 1 socket por cada sendMessage(), cierra al recibir.
//    - este:          abre 1 socket UNA vez, reutiliza para N transacciones.
//
//  Cómo funciona:
//    1. connect()    abre el socket, activa TCP_NODELAY + KEEPALIVE,
//                    arranca el receiver loop.
//    2. send()       solo escribe el buffer al socket y registra
//                    { stan → promise } en this.pending.
//    3. receiver loop lee del socket continuamente, extrae cada mensaje
//                    completo (puede haber varios pegados en un chunk),
//                    parsea el STAN (DE 11) y resuelve la promise.
//    4. Si el socket cae, se rechazan todas las pending y se intenta
//                    reconectar con backoff.
//
//  Eventos emitidos:
//    'connected'         conexión establecida (incluye reconexiones)
//    'disconnected'      socket cerrado
//    'error'             error del socket o del parser
//    'orphan-response'   { reason, stan?, parsed }  -- respuesta sin pending
//                        reason ∈ 'no-stan' | 'no-pending'
//                        'no-pending' = exactamente el bug de cruce de Postilion
//    'giveup'            { attempts }  -- se agotó el retry de reconexión
//
//  Uso típico:
//    const client = new PosClient({ host, port });
//    await client.connect();
//    const { response, elapsedMs } = await client.send({ message, stan });
//
// ============================================================================

'use strict';

const net = require('net');
const EventEmitter = require('events');
const { parseResponse } = require('./iso8583');

class PosClient extends EventEmitter {
  constructor({
    host,
    port,
    defaultTimeoutMs    = 31000,
    reconnectDelayMs    = 1000,
    maxReconnectAttempts = 10,
    keepAliveMs         = 30000,
    verbose             = false,
  } = {}) {
    super();
    this.host = host;
    this.port = port;
    this.defaultTimeoutMs     = defaultTimeoutMs;
    this.reconnectDelayMs     = reconnectDelayMs;
    this.maxReconnectAttempts = maxReconnectAttempts;
    this.keepAliveMs          = keepAliveMs;
    this.verbose              = verbose;

    this.socket        = null;
    this.connected     = false;
    this.connecting    = false;
    this.shuttingDown  = false;

    this.pending = new Map();          // stan(str) → { resolve, reject, timer, t0 }
    this.buf     = Buffer.alloc(0);
    this.reconnectAttempts = 0;

    this.stats = {
      sent:          0,
      received:      0,
      errors:        0,
      timeouts:      0,
      reconnects:    0,
      orphans:       0,
      bufferPegado:  0,    // chunks que trajeron > 1 mensaje completo
    };
  }

  _log(...args) {
    if (this.verbose) console.log('[POS-PIPE]', ...args);
  }

  // --------------------------------------------------------------------------
  // connect() — abre el socket. Si ya está conectado, resuelve inmediato.
  // Si está conectándose, espera al evento.
  // --------------------------------------------------------------------------
  connect() {
    return new Promise((resolve, reject) => {
      if (this.connected)  return resolve();
      if (this.connecting) {
        this.once('connected', resolve);
        this.once('error', reject);
        return;
      }

      this.connecting = true;
      this.shuttingDown = false;
      this.socket = new net.Socket();
      this.buf = Buffer.alloc(0);

      const onceConnect = () => {
        this.socket.setNoDelay(true);                       // Nagle OFF
        this.socket.setKeepAlive(true, this.keepAliveMs);   // detecta sockets zombie
        this.connected  = true;
        this.connecting = false;
        const wasReconnect = this.reconnectAttempts > 0;
        this.reconnectAttempts = 0;
        this._log(`Conectado a ${this.host}:${this.port}${wasReconnect ? ' (reconexión)' : ''}`);
        this.emit('connected', { reconnected: wasReconnect });
        resolve();
      };

      const onceErrorEarly = (err) => {
        this.connecting = false;
        this.connected  = false;
        this._log('Error en connect:', err.message);
        this.emit('error', err);
        if (!this.shuttingDown) this._scheduleReconnect();
        reject(err);
      };

      this.socket.once('connect', onceConnect);
      this.socket.once('error',   onceErrorEarly);

      // Estos handlers viven durante toda la vida del socket
      this.socket.on('data',  (chunk) => this._onData(chunk));
      this.socket.on('close', ()      => this._onClose());

      this.socket.connect(this.port, this.host);
    });
  }

  // --------------------------------------------------------------------------
  // send({ message, stan, timeoutMs? })
  //
  // message  Buffer: mensaje ISO 8583 completo con LOTR ya incluido
  //                  (idem al que produce buildMessage de iso8583.js)
  // stan     string: STAN (DE 11) ya inyectado en el buffer
  // timeoutMs        timeout para ESTA request (default: this.defaultTimeoutMs)
  //
  // Devuelve: Promise<{ response: parsedResponse, raw: Buffer, elapsedMs }>
  // --------------------------------------------------------------------------
  send({ message, stan, timeoutMs }) {
    if (!this.connected) {
      this.stats.errors++;
      return Promise.reject(new Error('PosClient no está conectado'));
    }
    if (typeof stan !== 'string' || stan.length === 0) {
      return Promise.reject(new Error('send() requiere stan como string no vacío'));
    }
    if (this.pending.has(stan)) {
      // STAN reutilizado mientras el anterior sigue pending
      // → el nextStan() del caller dio la vuelta demasiado rápido
      return Promise.reject(new Error(`STAN ${stan} colisión: ya hay una request pending con ese STAN`));
    }

    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tmo = timeoutMs || this.defaultTimeoutMs;

      const timer = setTimeout(() => {
        if (this.pending.has(stan)) {
          this.pending.delete(stan);
          this.stats.timeouts++;
          reject(new Error(`Timeout ${tmo}ms (STAN=${stan})`));
        }
      }, tmo);

      this.pending.set(stan, { resolve, reject, timer, t0 });

      try {
        const ok = this.socket.write(message);
        this.stats.sent++;
        if (!ok) {
          // Backpressure: el kernel buffer está lleno.
          // No es error — solo info; el socket dispara 'drain' cuando vacía.
          this._log(`Backpressure al enviar STAN=${stan}`);
        }
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(stan);
        this.stats.errors++;
        reject(err);
      }
    });
  }

  // --------------------------------------------------------------------------
  // _onData: el corazón del pipelining. Acumula chunks y extrae TODOS los
  // mensajes completos del buffer (puede haber varios pegados).
  // --------------------------------------------------------------------------
  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    let messagesInChunk = 0;

    while (this.buf.length >= 2) {
      const len = this.buf.readUInt16BE(0);
      if (this.buf.length < 2 + len) break;        // mensaje incompleto, esperar

      const msg = this.buf.slice(0, 2 + len);
      this.buf = this.buf.slice(2 + len);          // consumir
      this._handleResponse(msg);
      messagesInChunk++;
    }

    if (messagesInChunk > 1) {
      this.stats.bufferPegado++;
      this._log(`Buffer pegado: ${messagesInChunk} mensajes en un solo chunk`);
    }
  }

  _handleResponse(rawMsg) {
    let parsed;
    try {
      parsed = parseResponse(rawMsg);
    } catch (err) {
      this.emit('error', new Error('Parse error: ' + err.message));
      return;
    }

    const stan = parsed.fields && parsed.fields[11];
    if (!stan) {
      this.stats.orphans++;
      this.emit('orphan-response', { reason: 'no-stan', parsed });
      return;
    }

    const pending = this.pending.get(stan);
    if (!pending) {
      // ¡El bug de Postilion en vivo!
      // Llegó una respuesta cuyo STAN no tenemos pending. Puede ser:
      //   - Una respuesta cruzada de otro cliente (bug histórico de Postilion)
      //   - Una respuesta que llegó después del timeout
      this.stats.orphans++;
      this.emit('orphan-response', { reason: 'no-pending', stan, parsed });
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(stan);
    this.stats.received++;

    pending.resolve({
      response:  parsed,
      raw:       rawMsg,
      elapsedMs: Date.now() - pending.t0,
    });
  }

  // --------------------------------------------------------------------------
  // _onClose: el socket se cerró. Rechazo todas las pending, intento reconectar.
  // --------------------------------------------------------------------------
  _onClose() {
    const wasConnected = this.connected;
    this.connected = false;
    this.buf = Buffer.alloc(0);

    // Rechazar todas las pending
    const rejecting = this.pending.size;
    for (const [stan, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('Socket cerrado, request abortada (STAN=' + stan + ')'));
    }
    this.pending.clear();

    if (wasConnected) {
      this._log(`Socket cerrado, ${rejecting} pending rechazadas`);
      this.emit('disconnected');
    }

    if (!this.shuttingDown) {
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this._log(`Agotados ${this.reconnectAttempts} intentos de reconexión`);
      this.emit('giveup', { attempts: this.reconnectAttempts });
      return;
    }
    this.reconnectAttempts++;
    this.stats.reconnects++;
    // Backoff lineal con tope (1s, 2s, 3s, 4s, 5s, 5s, 5s...)
    const delay = this.reconnectDelayMs * Math.min(this.reconnectAttempts, 5);
    this._log(`Reconectando en ${delay}ms (intento ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    setTimeout(() => {
      if (this.shuttingDown) return;
      this.connect().catch(() => {/* scheduleReconnect ya se encadena en onError */});
    }, delay);
  }

  // --------------------------------------------------------------------------
  // disconnect(): cierre ordenado. No reconecta.
  // --------------------------------------------------------------------------
  disconnect() {
    this.shuttingDown = true;
    if (this.socket) {
      try { this.socket.end(); } catch (_) {}
      try { this.socket.destroy(); } catch (_) {}
    }
    for (const [stan, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('Cliente desconectado por el usuario (STAN=' + stan + ')'));
    }
    this.pending.clear();
    this._log('Disconnect manual');
  }

  getStats() {
    return {
      ...this.stats,
      pendingCount: this.pending.size,
      connected:    this.connected,
      host:         this.host,
      port:         this.port,
    };
  }
}

module.exports = { PosClient };