// csr/routes/pos-sim.js
// ============================================================================
//  Rutas Express para el simulador POS web.
//
//  Endpoints:
//      POST /api/pos/send         - Una transacción individual
//      POST /api/pos/burst        - N transacciones (resumen al final)
//      POST /api/pos/burst-stream - N transacciones con SSE en tiempo real
//      POST /api/pos/burst-cancel - Cancelar burst en curso
//      GET  /api/pos/template     - Plantilla con campos del JSON real
//
//  Configuración (.env):
//      SWITCH_HOST=64.212.72.26
//      SWITCH_PORT=8183
//      SWITCH_TIMEOUT_MS=31000
//      TZ_OFFSET_HOURS=-4        (opcional, default -4 = Venezuela)
// ============================================================================

'use strict';

const express = require('express');
const { buildMessage, parseResponse, FIELD_DEF, ACCOUNT_TYPES } = require('../lib/iso8583');
const { sendMessage } = require('../lib/pos-client');
const { encryptPinBlock } = require('../lib/pinblock');

const router = express.Router();

// TPK (Terminal PIN Key) para cifrar el PIN block del DE52. Debe coincidir
// con la TPK que el simulador usa para validar (tpk-demo). Configurable por env.
const POS_TPK_HEX = process.env.POS_TPK_HEX || '1A2B3C4D5E6F70819AABBCCDDEEFF001';

const SWITCH_HOST = process.env.SWITCH_HOST     || '64.212.72.26';
const SWITCH_PORT = parseInt(process.env.SWITCH_PORT     || '8183', 10);
const TIMEOUT_MS  = parseInt(process.env.SWITCH_TIMEOUT_MS || '31000', 10);
const BURST_MAX   = parseInt(process.env.BURST_MAX || '50000', 10);

// Offset de zona horaria para DE 7/12/13.
// Venezuela es UTC-4 (sin horario de verano). Si el servidor Node corre en
// Render u otro host en UTC, sin este offset el DE 12/13 sale adelantado.
// Configurable por .env (TZ_OFFSET_HOURS), default -4.
const TZ_OFFSET_HOURS = parseFloat(process.env.TZ_OFFSET_HOURS || '-4');

let stanCounter = 1;
function nextStan() {
  const v = stanCounter;
  stanCounter = (stanCounter % 999999) + 1;
  return v.toString().padStart(6, '0');
}

// Timestamp con offset opcional (segundos) + ajuste de zona horaria.
// Tomamos el instante UTC, sumamos TZ_OFFSET_HOURS, y leemos con getUTC*
// (que ahora representan la hora local de Venezuela UTC-4).
function now(offsetSec = 0) {
  const d = new Date(Date.now() + offsetSec * 1000 + TZ_OFFSET_HOURS * 3600 * 1000);
  const MM = String(d.getUTCMonth() + 1).padStart(2, '0');
  const DD = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return {
    de7:  MM + DD + hh + mm + ss,
    de12: hh + mm + ss,
    de13: MM + DD,
  };
}

/**
 * Toma campos del form, completa STAN y timestamps, arma buffer ISO 8583.
 * El listener de Recarga (34026) NO espera DE 7.
 *
 * NOTA REVERSO (0400): si el payload ya trae DE 11/12/13 (caso del reverso,
 * que reusa los de la transacción original), se respetan tal cual. Solo se
 * autogeneran cuando NO vienen (caso compra nueva).
 */
function assembleMessage(payload) {
  const ts   = now();
  const stan = (payload.fields && payload.fields[11]) || nextStan();

  const fields = { ...(payload.fields || {}) };
  fields[11] = stan;
  fields[12] = fields[12] || ts.de12;
  fields[13] = fields[13] || ts.de13;

  // Escenario CON PIN: si el payload trae un PIN en claro, se cifra como
  // PIN block ISO-0 con la TPK y se coloca en DE52. Sin `pin`, no se toca
  // nada (escenario SIN PIN = comportamiento actual).
  if (payload.pin) {
    const pan = String(fields[2] || '');
    const keyHex = payload.pinKeyHex || POS_TPK_HEX;
    fields[52] = encryptPinBlock(payload.pin, pan, keyHex);
  }

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

const activeBursts = new Map();

function newBurstId() {
  return 'burst_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

// Destinos TCP disponibles para el POS. El simulador ISO 8583 local se
// configura con SIM8583_HOST / SIM8583_PORT (default 127.0.0.1:8583).
const SIM8583_HOST = process.env.SIM8583_HOST || '127.0.0.1';
const SIM8583_PORT = parseInt(process.env.SIM8583_PORT || '8583', 10);

const TARGETS = [
  { id: 'as400', name: `Switch AS/400 (${SWITCH_HOST}:${SWITCH_PORT})`, host: SWITCH_HOST, port: SWITCH_PORT },
  { id: 'sim',   name: `Simulador ISO 8583 (${SIM8583_HOST}:${SIM8583_PORT})`, host: SIM8583_HOST, port: SIM8583_PORT },
];

router.get('/template', (req, res) => {
  res.json({
    accountTypes: ACCOUNT_TYPES,
    fieldDef:     FIELD_DEF,
    targets:      TARGETS,
    config: {
      host: SWITCH_HOST,
      port: SWITCH_PORT,
      timeoutMs: TIMEOUT_MS,
      burstMax: BURST_MAX,
      tzOffsetHours: TZ_OFFSET_HOURS,
    },
  });
});

// ----------------------------------------------------------------------------
// POST /api/pos/send
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
// POST /api/pos/burst
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
// ----------------------------------------------------------------------------
router.post('/burst-stream', async (req, res) => {
  const count   = Math.min(Math.max(parseInt(req.body.count || '1', 10), 1), BURST_MAX);
  const host    = req.body.host || SWITCH_HOST;
  const port    = parseInt(req.body.port, 10) || SWITCH_PORT;
  const burstId = newBurstId();

  let mode = req.body.mode;
  if (!mode) mode = req.body.parallel ? 'parallel' : 'sequential';
  if (!['parallel', 'parallel-delay', 'sequential'].includes(mode)) mode = 'sequential';
  const delayMs = Math.min(Math.max(parseInt(req.body.delayMs || '1500', 10), 50), 10000);

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

  let burstDone = false;

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

  try {
    if (mode === 'parallel') {
      const promises = [];
      for (let i = 0; i < count; i++) {
        if (state.cancelled) break;
        promises.push(one(i));
      }
      await Promise.all(promises);

    } else if (mode === 'parallel-delay') {
      const promises = [];
      for (let i = 0; i < count; i++) {
        if (state.cancelled) break;
        promises.push(one(i));
        if (i < count - 1 && !state.cancelled) {
          await sleepWithHeartbeat(delayMs, res);
        }
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
    burstDone = true;
    activeBursts.delete(burstId);
    res.end();
  }
});

// ----------------------------------------------------------------------------
// POST /api/pos/burst-cancel
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


