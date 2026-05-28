// test-mock.js
// ============================================================================
//  Prueba el PosClient contra un switch SIMULADO que reproduce los 3
//  comportamientos que importan:
//    1. Respuesta normal (0200 → 0210 con mismo STAN)
//    2. BUFFER PEGADO: dos respuestas en un solo write() del socket
//    3. RESPUESTA CRUZADA: responde con un STAN que no corresponde (bug Postilion)
//
//  No toca el switch real. Sirve para validar la lógica del cliente.
//  Correr:  node test-mock.js
// ============================================================================

'use strict';

const net = require('net');
const { PosClient } = require('./csr/lib/pos-client-pipelined');
const { buildMessage, parseResponse, bcdPack } = require('./csr/lib/iso8583');

const PORT = 39999;

// ---------------------------------------------------------------------------
// Construye una respuesta 0210 a partir de un STAN dado.
// Mínima: TPDU + MTI + bitmap(DE 11, 39) + STAN + DE39.
// ---------------------------------------------------------------------------
function buildResponse(stan, responseCode = '00') {
  return buildMessage({
    mti: '0210',
    fields: { 11: stan, 39: responseCode },
  });
}

// ---------------------------------------------------------------------------
// Extrae el STAN (DE 11) de una request entrante.
// ---------------------------------------------------------------------------
function extractStan(buf) {
  const parsed = parseResponse(buf);   // parseResponse sirve para ambos sentidos
  return parsed.fields && parsed.fields[11];
}

// ---------------------------------------------------------------------------
// Mock server con comportamiento configurable
// ---------------------------------------------------------------------------
function startMockSwitch({ pegadoEvery = 5, cruzadoEvery = 7, replyDelayMs = 30 } = {}) {
  let reqCount = 0;
  const stats = { requests: 0, normal: 0, pegado: 0, cruzado: 0 };

  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    const queue = [];   // STANs pendientes de responder

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      // El mock también tiene que de-framear por LOTR
      while (buf.length >= 2) {
        const len = buf.readUInt16BE(0);
        if (buf.length < 2 + len) break;
        const msg = buf.slice(0, 2 + len);
        buf = buf.slice(2 + len);
        const stan = extractStan(msg);
        if (stan) { queue.push(stan); stats.requests++; }
      }

      // Procesar la cola con un pequeño delay (simula latencia del switch)
      setTimeout(() => {
        while (queue.length) {
          reqCount++;
          const stan = queue.shift();

          // ¿Toca cruzar esta respuesta? (bug Postilion)
          if (reqCount % cruzadoEvery === 0) {
            const fakeStan = '999' + String(reqCount % 1000).padStart(3, '0');
            socket.write(buildResponse(fakeStan, '00'));
            stats.cruzado++;
            continue;
          }

          // ¿Toca pegar dos respuestas en un solo write?
          if (reqCount % pegadoEvery === 0 && queue.length > 0) {
            const stan2 = queue.shift();
            const pegado = Buffer.concat([
              buildResponse(stan,  '00'),
              buildResponse(stan2, '00'),
            ]);
            socket.write(pegado);   // ← dos mensajes, un solo write
            stats.pegado += 2;
            continue;
          }

          // Respuesta normal
          socket.write(buildResponse(stan, '00'));
          stats.normal++;
        }
      }, replyDelayMs);
    });

    socket.on('error', () => {});
  });

  return new Promise((resolve) => {
    server.listen(PORT, '127.0.0.1', () => resolve({ server, stats }));
  });
}

// ---------------------------------------------------------------------------
// Genera una request de prueba con STAN dado
// ---------------------------------------------------------------------------
function buildTestTx(stan) {
  return buildMessage({
    mti: '0200',
    fields: {
      2:  '5171830300761071',
      3:  '003000',
      4:  '000000010785',
      11: stan,
      12: '120000',
      13: '0527',
      41: '01022254',
      42: '000000720004108',
    },
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('🧪 Levantando switch MOCK en 127.0.0.1:' + PORT);
  const { server, stats } = await startMockSwitch({ pegadoEvery: 5, cruzadoEvery: 7, replyDelayMs: 25 });

  const client = new PosClient({
    host: '127.0.0.1',
    port: PORT,
    defaultTimeoutMs: 5000,
    verbose: false,
  });

  let orphanCount = 0;
  client.on('orphan-response', ({ reason, stan }) => {
    orphanCount++;
    console.log(`   ⚠️  orphan (${reason}) STAN=${stan || '?'}  ← respuesta cruzada detectada y descartada limpiamente`);
  });

  await client.connect();
  console.log('✅ Cliente conectado\n');

  const COUNT = 40;
  const TPS   = 100;
  const intervalMs = 1000 / TPS;

  console.log(`🚀 Disparando ${COUNT} TX a ${TPS} tx/s sobre UNA conexión...\n`);

  const results = [];
  const promises = [];
  let stanN = 1;
  const nextStan = () => String(stanN++).padStart(6, '0');

  const t0 = Date.now();
  for (let i = 0; i < COUNT; i++) {
    const stan = nextStan();
    const msg = buildTestTx(stan);
    const p = client.send({ message: msg, stan })
      .then(r  => results.push({ stan, ok: true,  ms: r.elapsedMs, code: r.response.responseCode }))
      .catch(e => results.push({ stan, ok: false, error: e.message }));
    promises.push(p);
    if (i < COUNT - 1) await new Promise(r => setTimeout(r, intervalMs));
  }

  await Promise.all(promises);
  const totalMs = Date.now() - t0;

  const oks  = results.filter(r => r.ok);
  const errs = results.filter(r => !r.ok);
  const times = oks.map(r => r.ms).sort((a, b) => a - b);
  const avg = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0;
  const p95 = times.length ? times[Math.floor(times.length * 0.95)] : 0;

  console.log('\n📊 RESULTADOS DEL TEST');
  console.log('─'.repeat(52));
  console.log(`Transacciones enviadas    ${COUNT}`);
  console.log(`TPS efectivo              ${(COUNT * 1000 / totalMs).toFixed(1)}`);
  console.log(`OK (respuesta correlada)  ${oks.length}`);
  console.log(`Errores / timeouts        ${errs.length}`);
  console.log(`Latencia avg / p95        ${avg} / ${p95} ms`);
  console.log('');
  console.log('Comportamiento del switch mock:');
  console.log(`  Respuestas normales     ${stats.normal}`);
  console.log(`  En buffer pegado        ${stats.pegado}  ← 2 mensajes en 1 write TCP`);
  console.log(`  Respuestas cruzadas     ${stats.cruzado}  ← STAN inexistente (bug Postilion)`);
  console.log('');
  console.log('Stats del cliente:');
  const cs = client.getStats();
  console.log(`  sent=${cs.sent} received=${cs.received} timeouts=${cs.timeouts} orphans=${cs.orphans} bufferPegado=${cs.bufferPegado}`);
  console.log('');

  // Validaciones
  const expectedOk = COUNT - stats.cruzado;   // las cruzadas dejan su request original en timeout
  let pass = true;
  const check = (cond, label) => { console.log(`  ${cond ? '✅' : '❌'} ${label}`); if (!cond) pass = false; };

  console.log('VALIDACIONES:');
  check(cs.bufferPegado > 0, `Buffer pegado detectado y separado (${cs.bufferPegado} chunks con >1 msg)`);
  check(cs.orphans === stats.cruzado, `Respuestas cruzadas detectadas como orphan (${cs.orphans}/${stats.cruzado})`);
  check(cs.received > 0, `Respuestas correladas por STAN (${cs.received})`);
  check(oks.length >= stats.normal + stats.pegado - stats.cruzado, `Mayoría de TX correladas correctamente`);
  check(cs.pendingCount === 0, `Sin pending colgadas al final (${cs.pendingCount})`);

  console.log('\n' + (pass ? '🎉 TODAS LAS VALIDACIONES PASARON' : '⚠️  ALGUNA VALIDACIÓN FALLÓ'));

  client.disconnect();
  server.close();
  process.exit(pass ? 0 : 1);
}

main().catch(e => { console.error('💥', e); process.exit(1); });
