const express = require('express');
const net     = require('net');
const fetch   = (...args) => import('node-fetch')
    .then(({ default: f }) => f(...args));

const app = express();
// Aumentar límite de body porque el EMV puede ser largo
app.use(express.json({ limit: '1mb' }));

// Permitir que Render llame a este relay
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    next();
});

// ============================================================
// HELPER: sendTcp
// Abre socket TCP al switch, envía buffer ISO 8583 y espera
// respuesta usando prefijo LOTR de 2 bytes BE.
// Reutiliza el mismo patrón que lib/pos-client.js para que el
// modo BRIDGE y el modo TCP-DIRECTO se comporten igual.
// ============================================================
function sendTcp({ host, port, message, timeoutMs = 60000 }) {
    return new Promise((resolve, reject) => {
        const socket = new net.Socket();
        let received    = Buffer.alloc(0);
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
            try { socket.end(); } catch (_) {}
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

            if (expectedLen < 0 && received.length >= 2) {
                expectedLen = received.readUInt16BE(0);
            }
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

// ============================================================
// RELAY ISO 8583 — CRUD_PR01
// ============================================================
app.post('/relay', async (req, res) => {
    console.log('📡 ISO 8583 petición:', req.body);
    try {
        const response = await fetch(
            'http://172.23.12.2:10022/web/services/CRUD_PR01/prueba1',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(req.body)
            }
        );
        const data = await response.text();
        console.log('✅ ISO 8583 respuesta:', data.substring(0, 100));
        res.send(data);
    } catch (e) {
        console.error('❌ Error ISO 8583:', e.message);
        res.status(500).json({ ok: false, msg: e.message });
    }
});

// ============================================================
// RELAY LLAVES CRIPTOGRÁFICAS — Crud_Trafi800
// ============================================================
app.post('/relay-llaves', async (req, res) => {
    const { endpoint, body } = req.body;
    console.log(`🔑 TRAFI800 petición: /${endpoint}`, body);
    try {
        const response = await fetch(
            `http://172.23.12.2:10022/web/services/Crud_Trafi800/${endpoint}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            }
        );
        const data = await response.text();
        console.log('✅ TRAFI800 respuesta:', data.substring(0, 100));
        res.send(data);
    } catch (e) {
        console.error('❌ Error TRAFI800:', e.message);
        res.status(500).json({ ok: false, msg: e.message });
    }
});

// ============================================================
// BRIDGE HTTP→TCP — Simulador POS
// Recibe mensaje ISO 8583 en hex, lo manda por TCP al switch
// y devuelve la respuesta también en hex.
//
// Body: {
//   hexMessage: "01356000500100..."  (hex string completo con LOTR)
//   host:       "172.23.12.2"        (opcional, default 172.23.12.2)
//   port:       34026                (opcional, default 34026)
//   timeoutMs:  60000                (opcional, default 60000)
// }
//
// Response: {
//   ok: true,
//   responseHex: "00536000500100...",
//   responseLen: 85,
//   elapsedMs: 245
// }
//
// NOTA TIMEOUT: el default subió de 10000 a 60000ms. Los reversos (0420)
// bajo carga con los 7 puertos activos pueden tardar ~32s (Postilion busca
// la transacción original + cruce + reencaminamiento). Con 10s o 31s se
// cortaban antes de que llegara la respuesta. 60s da margen suficiente.
// ============================================================
app.post('/pos-tcp', async (req, res) => {
    const {
        hexMessage,
        host      = '172.23.12.2',
        port      = 34026,
        timeoutMs = 60000,
    } = req.body || {};

    if (!hexMessage || typeof hexMessage !== 'string') {
        return res.status(400).json({
            ok: false,
            error: 'Falta hexMessage (string hex del buffer ISO 8583)',
        });
    }
    if (hexMessage.length % 2 !== 0) {
        return res.status(400).json({
            ok: false,
            error: 'hexMessage tiene longitud impar (no es hex válido)',
        });
    }

    let messageBuffer;
    try {
        messageBuffer = Buffer.from(hexMessage, 'hex');
    } catch (e) {
        return res.status(400).json({
            ok: false,
            error: `hexMessage no se pudo decodificar: ${e.message}`,
        });
    }

    console.log(`🏧 POS-TCP → ${host}:${port} · ${messageBuffer.length}b`);
    console.log(`📤 HEX REQUEST: ${hexMessage.toUpperCase()}`);

    try {
        const result = await sendTcp({
            host,
            port,
            message: messageBuffer,
            timeoutMs: parseInt(timeoutMs, 10) || 60000,
        });

        console.log(`✅ POS-TCP ← ${host}:${port} · ${result.response.length}b · ${result.elapsedMs}ms`);

        res.json({
            ok:          true,
            responseHex: result.response.toString('hex').toUpperCase(),
            responseLen: result.response.length,
            elapsedMs:   result.elapsedMs,
            target:      `${host}:${port}`,
        });
    } catch (err) {
        console.error(`❌ POS-TCP error: ${err.message}`);
        res.status(500).json({
            ok:    false,
            error: err.message,
        });
    }
});

// ============================================================
// RELAY MONITOR REST — MON_REST
// ============================================================
app.post('/relay-monrest', async (req, res) => {
    const { endpoint, body } = req.body || {};
    if (!endpoint) {
        return res.status(400).json({ ok: false, msg: 'endpoint requerido' });
    }
    console.log(`📊 MON_REST petición: /${endpoint}`);
    try {
        const response = await fetch(
            `http://172.23.12.2:10022/web/services/MON_REST/${endpoint}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body || {})
            }
        );
        const data = await response.text();
        console.log(`✅ MON_REST respuesta: ${data.substring(0, 80)}...`);
        res.status(response.status).send(data);
    } catch (e) {
        console.error('❌ Error MON_REST:', e.message);
        res.status(500).json({ ok: false, msg: e.message });
    }
});

// ============================================================
// CHECK TCP — verifica si un puerto está abierto desde el relay
// (server.js no tiene acceso TCP directo al AS/400 en Render)
// ============================================================
app.post('/check-tcp', (req, res) => {
    const { host = '172.23.12.2', port, timeoutMs = 4000 } = req.body || {};
    if (!port) {
        return res.status(400).json({ ok: false, msg: 'port requerido' });
    }

    const t0 = Date.now();
    const socket = new net.Socket();
    let done = false;

    const finish = (up, error) => {
        if (done) return;
        done = true;
        socket.destroy();
        res.json({
            ok: true,
            host,
            port,
            up,
            latencia: Date.now() - t0,
            error: error || null
        });
    };

    socket.setTimeout(timeoutMs);
    socket.connect(port, host, () => finish(true, null));
    socket.on('error', e => finish(false, e.message));
    socket.on('timeout', () => finish(false, 'TCP timeout'));
});

app.listen(4000, () => console.log('🔁 Relay activo en :4000'));

