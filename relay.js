const express = require('express');
const fetch = (...args) => import('node-fetch')
    .then(({ default: f }) => f(...args));

const app = express();
app.use(express.json());

// Permitir que Render llame a este relay
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

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

app.listen(4000, () => console.log('🔁 Relay activo en :4000'));
