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
  const count    = Math.min(Math.max(parseInt(req.body.count || '1', 10), 1), 10000);
  const parallel = !!req.body.parallel;
  const host     = req.body.host || SWITCH_HOST;
  const port     = parseInt(req.body.port, 10) || SWITCH_PORT;

  console.log(`⚡ POS burst → ${host}:${port} · count=${count} · parallel=${parallel}`);

  const t0 = Date.now();

  async function one(i) {
    try {
      // DE 12 con +1seg garantizado por iteración
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
    if (state.cancelled) break;
    promises.push(one(i));
  }
  await Promise.all(promises);   // ← Todas en paralelo
} else {
  for (let i = 0; i < count; i++) {
    if (state.cancelled) break;
    await one(i);                // ← Una por vez
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
// Body: { mti, fields, count, parallel?: bool }
// Emite eventos:
//   data: {type:'start', burstId, count, target}
//   data: {type:'tx-start', i, stan, requestLen}
//   data: {type:'tx-end',   i, stan, ok, elapsedMs, responseCode, responseMsg, error}
//   data: {type:'done',     totalMs, okCount, failedCount, tps}
//   data: {type:'cancelled', burstId, completed}
// ----------------------------------------------------------------------------
router.post('/burst-stream', async (req, res) => {
  const count    = Math.min(Math.max(parseInt(req.body.count || '1', 10), 1), 10000);
  const parallel = !!req.body.parallel;
  const host     = req.body.host || SWITCH_HOST;
  const port     = parseInt(req.body.port, 10) || SWITCH_PORT;
  const burstId  = newBurstId();

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

  console.log(`⚡ POS burst-stream → ${host}:${port} · count=${count} · parallel=${parallel} · ${burstId}`);

  send({ type: 'start', burstId, count, target: `${host}:${port}`, parallel });

  // Si el cliente cierra la conexión, marcamos como cancelado
  req.on('close', () => {
    state.cancelled = true;
    console.log(`🛑 POS burst-stream cancelled by client · ${burstId}`);
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

  // Procesamiento
  try {
    if (parallel) {
      const promises = [];
      for (let i = 0; i < count; i++) {
        if (state.cancelled) break;
        promises.push(one(i));
      }
      await Promise.all(promises);
    } else {
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
      });
      console.log(`✅ POS burst-stream done · ${okCount}/${count} OK · ${totalMs}ms · ${tps} TPS · ${burstId}`);
    }
  } catch (err) {
    send({ type: 'error', error: err.message });
    console.error('❌ POS burst-stream error:', err.message);
  } finally {
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
