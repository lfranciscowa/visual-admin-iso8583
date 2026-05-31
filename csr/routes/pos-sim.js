// csr/routes/pos-sim.js
// ============================================================================
//  Rutas Express para el simulador POS web.
//
//  Wiring en server.js (paso 7.4):
//      const posSim = require('./routes/pos-sim');
//      app.use('/api/pos', posSim);
//
//  Endpoints:
//      POST /api/pos/send         - Una transacción individual
//      POST /api/pos/burst        - N transacciones (resumen al final)
//      POST /api/pos/burst-stream - N transacciones con SSE en tiempo real
//      POST /api/pos/burst-cancel - Cancelar burst en curso
//      GET  /api/pos/template     - Plantilla con campos del JSON real
//
//  Configuración (.env):
//      SWITCH_HOST=172.23.12.2
//      SWITCH_PORT=34026
//      SWITCH_TIMEOUT_MS=31000
//
//  Modos de burst-stream:
//      sequential      : Una tras otra, espera respuesta
//      parallel        : Todas a la vez (puede saturar AISSER single-threaded)
//      parallel-delay  : Lanza cada N ms sin esperar respuesta (NUEVO)
// ============================================================================

'use strict';

const express = require('express');
const { buildMessage, parseResponse, FIELD_DEF, ACCOUNT_TYPES } = require('../lib/iso8583');
const { sendMessage } = require('../lib/pos-client');

const router = express.Router();

// Defaults confirmados por el equipo (se sobrescriben con .env)
const SWITCH_HOST = process.env.SWITCH_HOST     || '172.23.12.2';
const SWITCH_PORT = parseInt(process.env.SWITCH_PORT     || '34026', 10);
const TIMEOUT_MS  = parseInt(process.env.SWITCH_TIMEOUT_MS || '31000', 10);

// Tope de tx por burst (subido a 50.000 para pruebas de volumen)
const BURST_MAX = parseInt(process.env.BURST_MAX || '50000', 10);

// Contador en memoria para STAN (compartido entre llamadas del proceso)
let stanCounter = 1;
function nextStan() {
  const v = stanCounter;
  stanCounter = (stanCounter % 999999) + 1;
  return v.toString().padStart(6, '0');
}

// Helpers de timestamp con offset opcional (segundos)
function now(offsetSec = 0) {
  const d = new Date(Date.now() + offsetSec * 1000);
  const MM = String(d.getMonth() + 1).padStart(2, '0');
  const DD = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return {
    de7:  MM + DD + hh + mm + ss,
    de12: hh + mm + ss,
    de13: MM + DD,
  };
}

/**
 * Toma campos del form, completa STAN y timestamps, arma buffer ISO 8583.
 * El listener de Recarga (34026) NO espera DE 7.
 */
function assembleMessage(payload) {
  const ts   = now();
  const stan = (payload.fields && payload.fields[11]) || nextStan();

  const fields = { ...(payload.fields || {}) };
  fields[11] = stan;
  fields[12] = fields[12] || ts.de12;
  fields[13] = fields[13] || ts.de13;

  for (const k of Object.keys(fields)) {
    if (fields[k] === '' || fields[k] === null || fields[k] === undefined) {
      delete fields[k];
    }
  }

  const message = buildMessage({
    mti: payload.mti || '0200',
    fields,
  });

  return { message, stanUsed: stan, fieldsUsed: fields };
}

// Estado en memoria para soportar cancelación de burst-stream
const activeBursts = new Map(); // burstId → { cancelled: bool }

function newBurstId() {
  return 'burst_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
}

// Helper para pausa async (usado solo en lugares sin SSE)
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Sleep con heartbeat SSE para mantener viva la conexión del cliente
// (curl, navegadores y proxies suelen cerrar streams que se quedan inactivos)
function sleepWithHeartbeat(ms, res) {
  return new Promise(resolve => {
    const start = Date.now();
    const tick = 500;
    const timer = setInterval(() => {
      const elapsed = Date.now() - start;
      if (elapsed >= ms) {
        clearInterval(timer);
        resolve();
        return;
      }
      try {
        // Los comentarios SSE empiezan con ':' y son ignorados por EventSource
        res.write(`: heartbeat ${elapsed}ms\n\n`);
      } catch (_) {
        clearInterval(timer);
        resolve();
      }
    }, tick);
  });
}

// ----------------------------------------------------------------------------
// GET /api/pos/template
// ----------------------------------------------------------------------------
router.get('/template', (req, res) => {
  res.json({
    accountTypes: ACCOUNT_TYPES,
    fieldDef:     FIELD_DEF,
    config: {
      host: SWITCH_HOST,
      port: SWITCH_PORT,
      timeoutMs: TIMEOUT_MS,
      burstMax: BURST_MAX,
    },
  });
});

// ----------------------------------------------------------------------------
// POST /api/pos/send  (sin cambios)
// ----------------------------------------------------------------------------
router.post('/send', async (req, res) => {
  let message, stanUsed, fieldsUsed;
  const host = req.body.host || SWITCH_HOST;
  const port = parseInt(req.body.port, 10) || SWITCH_PORT;

  try {
    ({ message, stanUsed, fieldsUsed } = assembleMessage(req.body));
  } catch (err) {
    console.error('❌ POS encode:', err.message);
    return res.status(400).json({ ok: false, error: 'Encoding: ' + err.message });
  }

  const requestHex = message.toString('hex').toUpperCase();
  const requestLen = message.length;

  console.log(`📤 POS send → ${host}:${port} · STAN=${stanUsed} · ${requestLen}b`);

  try {
    const { response, elapsedMs } = await sendMessage({
      host, port, message, timeoutMs: TIMEOUT_MS,
    });
    console.log(`✅ POS resp ← ${host}:${port} · STAN=${stanUsed} · ${elapsedMs}ms · ${response.length}b`);

    res.json({
      ok:         true,
      stan:       stanUsed,
      fieldsUsed,
      requestHex,
      requestLen,
      response:   parseResponse(response),
      elapsedMs,
      target:     `${host}:${port}`,
    });
  } catch (err) {
    console.error('❌ POS send:', err.message);
    res.json({
      ok:         false,
      error:      err.message,
      stan:       stanUsed,
      fieldsUsed,
      requestHex,
      requestLen,
      target:     `${host}:${port}`,
    });
  }
});

// ----------------------------------------------------------------------------
// POST /api/pos/burst (resumen al final, comportamiento original)
// ----------------------------------------------------------------------------
router.post('/burst', async (req, res) => {
  const count    = Math.min(Math.max(parseInt(req.body.count || '1', 10), 1), BURST_MAX);
  const parallel = !!req.body.parallel;
  const host     = req.body.host || SWITCH_HOST;
  const port     = parseInt(req.body.port, 10) || SWITCH_PORT;

  console.log(`⚡ POS burst → ${host}:${port} · count=${count} · parallel=${parallel}`);

  const t0 = Date.now();

  async function one(i) {
    try {
      const ts = now(i);
      const payload = {
        ...req.body,
        fields: {
          ...(req.body.fields || {}),
          11: nextStan(),
          12: ts.de12,
          13: ts.de13,
        },
      };

      const { message, stanUsed } = assembleMessage(payload);
      const { response, elapsedMs } = await sendMessage({
        host, port, message, timeoutMs: TIMEOUT_MS,
      });
      const parsed = parseResponse(response);
      return {
        i,
        ok:        true,
        stan:      stanUsed,
        elapsedMs,
        mti:       parsed.mti,
        respLen:   response.length,
        responseCode: parsed.responseCode,
      };
    } catch (err) {
      return { i, ok: false, error: err.message };
    }
  }

  const results = [];
  if (parallel) {
    const promises = [];
    for (let i = 0; i < count; i++) {
      promises.push(one(i).then(r => results.push(r)));
    }
    await Promise.all(promises);
  } else {
    for (let i = 0; i < count; i++) {
      results.push(await one(i));
    }
  }

  const totalMs = Date.now() - t0;
  const okCount = results.filter(r => r.ok).length;
  const failed  = results.length - okCount;
  const tps     = totalMs > 0 ? (count * 1000 / totalMs).toFixed(2) : '0';

  console.log(`✅ POS burst done · ${okCount}/${count} OK · ${totalMs}ms · ${tps} TPS`);

  res.json({
    ok:          true,
    count,
    okCount,
    failedCount: failed,
    totalMs,
    tps,
    parallel,
    target:      `${host}:${port}`,
    samples:     results.slice(0, 20),
    failures:    results.filter(r => !r.ok).slice(0, 50),
  });
});

// ----------------------------------------------------------------------------
// POST /api/pos/burst-stream  (Server-Sent Events en tiempo real)
//
// Body: {
//   mti, fields,
//   count,
//   mode?: 'sequential' | 'parallel' | 'parallel-delay'   (default 'sequential')
//   delayMs?: number                                       (default 1500, solo aplica a parallel-delay)
//   parallel?: bool                                        (legacy, equivale a mode:'parallel')
// }
//
// Emite eventos SSE:
//   {type:'start',     burstId, count, target, mode, delayMs}
//   {type:'tx-start',  i, status}
//   {type:'tx-progress', i, stan, requestLen, status}
//   {type:'tx-end',    i, stan, ok, elapsedMs, responseCode, responseMsg, error}
//   {type:'done',      burstId, totalMs, okCount, failedCount, tps, count, mode}
//   {type:'cancelled', burstId, completed, totalCount, totalMs, okCount, failedCount, tps, mode}
//   {type:'error',     error}
// ----------------------------------------------------------------------------
router.post('/burst-stream', async (req, res) => {
  const count   = Math.min(Math.max(parseInt(req.body.count || '1', 10), 1), BURST_MAX);
  const host    = req.body.host || SWITCH_HOST;
  const port    = parseInt(req.body.port, 10) || SWITCH_PORT;
  const burstId = newBurstId();

  // -------- Resolver modo + delay --------
  // Soporte legacy: parallel:true (sin mode) ⇒ mode:'parallel'
  let mode = req.body.mode;
  if (!mode) mode = req.body.parallel ? 'parallel' : 'sequential';
  if (!['parallel', 'parallel-delay', 'sequential'].includes(mode)) mode = 'sequential';
  const delayMs = Math.min(Math.max(parseInt(req.body.delayMs || '1500', 10), 50), 10000);

  // Configurar SSE
  res.setHeader('Content-Type',       'text/event-stream');
  res.setHeader('Cache-Control',      'no-cache');
  res.setHeader('Connection',         'keep-alive');
  res.setHeader('X-Accel-Buffering',  'no');
  res.flushHeaders();

  const state = { cancelled: false };
  activeBursts.set(burstId, state);

  function send(event) {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch (_) { /* socket cerrado */ }
  }

  const modeLabel = mode === 'parallel-delay' ? `parallel-delay(${delayMs}ms)` : mode;
  console.log(`⚡ POS burst-stream → ${host}:${port} · count=${count} · mode=${modeLabel} · ${burstId}`);

  send({ type: 'start', burstId, count, target: `${host}:${port}`, mode, delayMs });

  // ─── Detección de cancelación del cliente (compatible Express 5) ───
  // OJO: En Express 5, req.on('close') se dispara también al cerrar
  // la response normalmente, generando falsos "cancelled" en streams.
  // Por eso usamos 'aborted' (cliente realmente abortó) y vigilamos
  // res.on('close') solo si la response NO terminó por nosotros.
  let burstDone = false;   // bandera para distinguir cierre intencional

  req.on('aborted', () => {
    state.cancelled = true;
    console.log(`🛑 POS burst-stream ABORTED by client · ${burstId}`);
  });
  res.on('close', () => {
    if (!burstDone && !res.writableEnded) {
      state.cancelled = true;
      console.log(`🛑 POS burst-stream response closed early · ${burstId}`);
    }
  });

  const t0 = Date.now();
  const results = [];

  async function one(i) {
    let stanUsed = '—', requestLen = 0;

    send({ type: 'tx-start', i, status: 'sending' });

    try {
      const ts = now(i);
      const payload = {
        ...req.body,
        fields: {
          ...(req.body.fields || {}),
          11: nextStan(),
          12: ts.de12,
          13: ts.de13,
        },
      };

      const { message, stanUsed: s } = assembleMessage(payload);
      stanUsed   = s;
      requestLen = message.length;

      send({ type: 'tx-progress', i, stan: stanUsed, requestLen, status: 'waiting' });

      const { response, elapsedMs } = await sendMessage({
        host, port, message, timeoutMs: TIMEOUT_MS,
      });
      const parsed = parseResponse(response);

      const result = {
        i,
        ok:           true,
        stan:         stanUsed,
        requestLen,
        elapsedMs,
        mti:          parsed.mti,
        responseCode: parsed.responseCode,
        responseMsg:  parsed.responseMsg,
        respLen:      response.length,
      };
      results.push(result);
      send({ type: 'tx-end', ...result });
      return result;

    } catch (err) {
      const result = {
        i,
        ok:    false,
        stan:  stanUsed,
        requestLen,
        elapsedMs: 0,
        error: err.message,
      };
      results.push(result);
      send({ type: 'tx-end', ...result });
      return result;
    }
  }

  // -------- Procesamiento según modo --------
  try {
    if (mode === 'parallel') {
      // Todas a la vez. Útil para pruebas de saturación.
      // OJO: AISSER es single-threaded; con count>2 suelen tirar timeout.
      const promises = [];
      for (let i = 0; i < count; i++) {
        if (state.cancelled) break;
        promises.push(one(i));
      }
      await Promise.all(promises);

    } else if (mode === 'parallel-delay') {
      // Fire-and-forget escalonado: lanza cada delayMs sin esperar respuesta
      // entre lanzamientos. Permite simular tráfico realista sin saturar
      // AISSER. delayMs=1500 ≈ tiempo típico de TX, es seguro.
      // Usa sleepWithHeartbeat para que el SSE no se cierre por inactividad
      // durante la pausa entre TX (clientes y proxies cortan streams ociosos).
      const promises = [];
      for (let i = 0; i < count; i++) {
        if (state.cancelled) break;
        promises.push(one(i));                          // NO hay await aquí
        if (i < count - 1 && !state.cancelled) {
          await sleepWithHeartbeat(delayMs, res);       // pausa con heartbeat
        }
      }
      await Promise.all(promises);                      // espera que las en vuelo terminen

    } else {
      // sequential: una tras otra, espera respuesta. Modo más seguro.
      for (let i = 0; i < count; i++) {
        if (state.cancelled) break;
        await one(i);
      }
    }

    const totalMs = Date.now() - t0;
    const okCount = results.filter(r => r.ok).length;
    const failed  = results.length - okCount;
    const tps     = totalMs > 0 ? (results.length * 1000 / totalMs).toFixed(2) : '0';

    if (state.cancelled) {
      send({
        type:        'cancelled',
        burstId,
        completed:   results.length,
        totalCount:  count,
        totalMs,
        okCount,
        failedCount: failed,
        tps,
        mode,
      });
      console.log(`🛑 POS burst-stream done (cancelled) · ${results.length}/${count} · ${burstId}`);
    } else {
      send({
        type:        'done',
        burstId,
        totalMs,
        okCount,
        failedCount: failed,
        tps,
        count,
        mode,
      });
      console.log(`✅ POS burst-stream done · ${okCount}/${count} OK · ${totalMs}ms · ${tps} TPS · ${burstId}`);
    }
  } catch (err) {
    send({ type: 'error', error: err.message });
    console.error('❌ POS burst-stream error:', err.message);
  } finally {
    burstDone = true;            // marca que terminamos intencionalmente
    activeBursts.delete(burstId);
    res.end();
  }
});

// ----------------------------------------------------------------------------
// POST /api/pos/burst-cancel
// Body: { burstId }
// ----------------------------------------------------------------------------
router.post('/burst-cancel', (req, res) => {
  const { burstId } = req.body;
  if (!burstId) return res.status(400).json({ ok: false, error: 'burstId requerido' });

  const state = activeBursts.get(burstId);
  if (!state) {
    return res.json({ ok: false, error: 'burst no encontrado o ya terminado' });
  }
  state.cancelled = true;
  console.log(`🛑 POS burst cancel solicitado · ${burstId}`);
  res.json({ ok: true, burstId });
});

module.exports = router;

