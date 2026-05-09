// csr/routes/pos-sim.js
// ============================================================================
//  Rutas Express para el simulador POS web.
//
//  Wiring en server.js (paso 7.4):
//      const posSim = require('./routes/pos-sim');
//      app.use('/api/pos', posSim);
//
//  Endpoints:
//      POST /api/pos/send        - Una transacción individual
//      POST /api/pos/burst       - N transacciones (secuencial o paralelo)
//      GET  /api/pos/template    - Plantilla con campos del JSON real
//
//  Configuración (.env):
//      SWITCH_HOST=172.23.12.2
//      SWITCH_PORT=34025
//      SWITCH_TIMEOUT_MS=10000
// ============================================================================

'use strict';

const express = require('express');
const { buildMessage, parseResponse, FIELD_DEF, ACCOUNT_TYPES } = require('../lib/iso8583');
const { sendMessage } = require('../lib/pos-client');

const router = express.Router();

// Defaults confirmados por el equipo (se sobrescriben con .env)
const SWITCH_HOST = process.env.SWITCH_HOST     || '172.23.12.2';
const SWITCH_PORT = parseInt(process.env.SWITCH_PORT     || '34025', 10);
const TIMEOUT_MS  = parseInt(process.env.SWITCH_TIMEOUT_MS || '10000', 10);

// Contador en memoria para STAN (compartido entre llamadas del proceso)
let stanCounter = 1;
function nextStan() {
  const v = stanCounter;
  stanCounter = (stanCounter % 999999) + 1;
  return v.toString().padStart(6, '0');
}

// Helpers de timestamp
function now() {
  const d = new Date();
  const MM = String(d.getMonth() + 1).padStart(2, '0');
  const DD = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return {
    de7:  MM + DD + hh + mm + ss,  // transmission datetime
    de12: hh + mm + ss,             // local time
    de13: MM + DD,                  // local date
  };
}

/**
 * Toma campos del form, completa STAN y timestamps, arma buffer ISO 8583.
 */
function assembleMessage(payload) {
  const ts   = now();
  const stan = (payload.fields && payload.fields[11]) || nextStan();

  const fields = { ...(payload.fields || {}) };
  fields[11] = stan;
  fields[12] = fields[12] || ts.de12;
  fields[13] = fields[13] || ts.de13;

  // Eliminar valores vacíos (no entran al bitmap)
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

// ----------------------------------------------------------------------------
// GET /api/pos/template
// Devuelve la plantilla con los DEs y la metadata de configuración.
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
// POST /api/pos/send
// Body: { mti, fields: {2:'...', 4:'...', ...}, host?, port? }
// ----------------------------------------------------------------------------
router.post('/send', async (req, res) => {
  let message, stanUsed, fieldsUsed;
  const host = req.body.host || SWITCH_HOST;
  const port = parseInt(req.body.port, 10) || SWITCH_PORT;

  try {
    ({ message, stanUsed, fieldsUsed } = assembleMessage(req.body));
  } catch (err) {
    // Error armando la trama (campo inválido, etc.) — no hay hex que mostrar
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
    // Devolvemos status 200 con ok:false para que el frontend pueda
    // mostrar el hex aunque haya timeout/error de red
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
// Body: { ...same as send..., count: N, parallel?: bool }
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
      const ts = now();
      const payload = {
        ...req.body,
        fields: {
          ...(req.body.fields || {}),
          7:  ts.de7,
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
      };
    } catch (err) {
      return { i, ok: false, error: err.message };
    }
  }

  const results = [];
  if (parallel) {
    const promises = [];
    for (let i = 0; i < count; i++) promises.push(one(i));
    const all = await Promise.all(promises);
    results.push(...all);
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

module.exports = router;
