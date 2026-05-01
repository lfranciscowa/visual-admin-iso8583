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

app.post('/relay', async (req, res) => {
    console.log('📡 Petición recibida:', req.body);
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
        console.log('✅ Respuesta AS/400:', data.substring(0, 100));
        res.send(data);
    } catch (e) {
        console.error('❌ Error:', e.message);
        res.status(500).json({ ok: false, msg: e.message });
    }
});

app.listen(4000, () => console.log('🔁 Relay activo en :4000'));