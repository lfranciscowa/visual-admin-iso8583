// test-pipelined.js
// ============================================================================
//  Prueba el PosClient contra el SWITCH REAL.
//
//  Dispara COUNT transacciones a TPS objetivo sobre UNA sola conexión TCP,
//  usando pipelining (no espera la respuesta de una para mandar la siguiente).
//  Correlaciona por STAN. Mide latencia (avg/p50/p95/p99) y throughput.
//
//  ⚠️  IMPORTANTE: los "orphan no-pending" que aparezcan acá son respuestas
//      CRUZADAS REALES del switch (el bug de Postilion). El simulador viejo
//      las perdía en silencio; este las detecta y las cuenta.
//
//  Uso:
//      SWITCH_HOST=172.23.12.2 SWITCH_PORT=34026 TPS=50 COUNT=100 node test-pipelined.js
//
//  Variables de entorno:
//      SWITCH_HOST   IP del switch        (default 172.23.12.2)
//      SWITCH_PORT   puerto               (default 34026)
//      TPS           tx/seg objetivo      (default 50)
//      COUNT         total de TX          (default 100)
//      TIMEOUT_MS    timeout por TX       (default 31000)
//      VERBOSE       1 para logs internos (default 0)
// ============================================================================

'use strict';

const { PosClient } = require('./csr/lib/pos-client-pipelined');
const { buildMessage } = require('./csr/lib/iso8583');

const HOST       = process.env.SWITCH_HOST || '172.23.12.2';
const PORT       = parseInt(process.env.SWITCH_PORT || '34026', 10);
const TPS        = parseInt(process.env.TPS   || '50', 10);
const COUNT      = parseInt(process.env.COUNT || '100', 10);
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || '31000', 10);
const VERBOSE    = process.env.VERBOSE === '1';

// --- STAN único monotónico, salta los que sigan pending -------------------
let stanN = 1;
function nextStan(client) {
  for (let tries = 0; tries < 999999; tries++) {
    const candidate = String(stanN).padStart(6, '0');
    stanN = (stanN % 999999) + 1;
    if (!client.pending.has(candidate)) return candidate;
  }
  throw new Error('No hay STANs libres (demasiadas pending)');
}

function nowParts() {
  const d = new Date();
  const MM = String(d.getMonth() + 1).padStart(2, '0');
  const DD = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return { de12: hh + mm + ss, de13: MM + DD };
}

// Plantilla de TX — ajustá los campos a lo que use tu switch (port 34026)
function buildTx(stan) {
  const ts = nowParts();
  return buildMessage({
    mti: '0200',
    fields: {
      2:  '5171830300761071',
      3:  '003000',
      4:  '000000010785',
      11: stan,
      12: ts.de12,
      13: ts.de13,
      14: '2401',
      22: '0051',
      23: '0001',
      24: '0003',
      25: '0004',
      32: '0000',
      35: '5171830300761071D24012011930567400000',
      41: '01022254',
      42: '000000720004108',
      47: 'com.tranred.milpagos.dev.rc1.4.90',
      56: 'Bs.',
      57: '0006109566',
      62: '000004',
      63: '37000001',
    },
  });
}

function pctl(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

async function main() {
  console.log(`🎯 Target   ${HOST}:${PORT}`);
  console.log(`⚙️  Config   ${COUNT} TX @ ${TPS} tx/s objetivo · timeout ${TIMEOUT_MS}ms`);
  console.log(`🔗 Modo     UNA conexión TCP persistente + pipelining\n`);

  const client = new PosClient({
    host: HOST, port: PORT,
    defaultTimeoutMs: TIMEOUT_MS,
    verbose: VERBOSE,
  });

  let orphanCruzado = 0;
  client.on('orphan-response', ({ reason, stan }) => {
    orphanCruzado++;
    console.log(`⚠️  CRUZADO: respuesta STAN=${stan || '?'} sin request pending (${reason}) — el simulador viejo la habría perdido`);
  });
  client.on('disconnected', () => console.log('🔌 Socket caído, reconectando...'));
  client.on('connected', ({ reconnected }) => { if (reconnected) console.log('✅ Reconectado'); });
  client.on('giveup', ({ attempts }) => console.log(`💀 Reconexión abandonada tras ${attempts} intentos`));

  try {
    await client.connect();
  } catch (e) {
    console.error(`❌ No se pudo conectar a ${HOST}:${PORT}: ${e.message}`);
    process.exit(1);
  }
  console.log('✅ Conectado\n');

  const results  = [];
  const promises = [];
  const intervalMs = 1000 / TPS;

  // ---- Inyección a tasa constante (scheduler no acumulativo) ----
  const injectStart = Date.now();

  for (let i = 0; i < COUNT; i++) {
    const targetTime = injectStart + i * intervalMs;
    const wait = targetTime - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));

    const stan = nextStan(client);
    const msg  = buildTx(stan);
    const txT0 = Date.now();

    const p = client.send({ message: msg, stan })
      .then(r  => results.push({ stan, ok: true,  ms: r.elapsedMs, code: r.response.responseCode || '??' }))
      .catch(e => results.push({ stan, ok: false, ms: Date.now() - txT0, error: e.message }));
    promises.push(p);
  }

  const injectEnd = Date.now();
  const injectMs  = injectEnd - injectStart;
  console.log(`\n📨 Inyección completa: ${COUNT} TX disparadas en ${(injectMs / 1000).toFixed(2)}s (${(COUNT * 1000 / injectMs).toFixed(1)} tx/s)`);
  console.log(`⏳ Esperando respuestas pendientes...\n`);

  await Promise.all(promises);
  const allDoneMs = Date.now() - injectStart;

  // ---- Métricas ----
  const oks    = results.filter(r => r.ok);
  const errs   = results.filter(r => !r.ok);
  const times  = oks.map(r => r.ms).sort((a, b) => a - b);
  const avg    = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0;

  // Distribución por response code
  const codeDist = {};
  oks.forEach(r => { codeDist[r.code] = (codeDist[r.code] || 0) + 1; });
  const errDist = {};
  errs.forEach(r => {
    const key = /Timeout/.test(r.error) ? 'timeout' : 'otro';
    errDist[key] = (errDist[key] || 0) + 1;
  });

  console.log('📊 RESULTADOS');
  console.log('═'.repeat(54));
  console.log(`Inyección (envío)         ${(injectMs / 1000).toFixed(2)}s → ${(COUNT * 1000 / injectMs).toFixed(1)} tx/s`);
  console.log(`Total (hasta últ. resp.)  ${(allDoneMs / 1000).toFixed(2)}s → ${(COUNT * 1000 / allDoneMs).toFixed(1)} tx/s throughput`);
  console.log('─'.repeat(54));
  console.log(`OK (correladas)           ${oks.length}/${COUNT}`);
  console.log(`Errores / timeouts        ${errs.length}`);
  console.log(`Cruzados detectados       ${orphanCruzado}  ← respuestas que el sim viejo perdía`);
  console.log('─'.repeat(54));
  console.log(`Latencia avg              ${avg} ms`);
  console.log(`Latencia p50 / p95 / p99  ${pctl(times, 0.5)} / ${pctl(times, 0.95)} / ${pctl(times, 0.99)} ms`);
  console.log(`Latencia min / max        ${times[0] || 0} / ${times[times.length - 1] || 0} ms`);
  console.log('─'.repeat(54));
  console.log('Distribución response code (DE 39):');
  Object.keys(codeDist).sort().forEach(c => console.log(`  ${c}   ${codeDist[c]}`));
  if (errs.length) {
    console.log('Errores:');
    Object.keys(errDist).forEach(k => console.log(`  ${k}   ${errDist[k]}`));
  }
  console.log('─'.repeat(54));
  const cs = client.getStats();
  console.log(`Cliente: sent=${cs.sent} recv=${cs.received} timeouts=${cs.timeouts} orphans=${cs.orphans} bufferPegado=${cs.bufferPegado} reconnects=${cs.reconnects}`);
  console.log('═'.repeat(54));

  client.disconnect();
  process.exit(0);
}

main().catch(e => { console.error('💥 Fatal:', e); process.exit(1); });
