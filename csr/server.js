const express = require('express');
const net     = require('net');
const cors    = require('cors');
const path    = require('path');
const crypto  = require('crypto');
const { Resend } = require('resend');
const db = require('./database');
const os = require('os');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// ============================================================
// MÓDULOS DEL SISTEMA — fuente única de verdad
// ============================================================
const MODULOS_SISTEMA = [
    { id: 'trama',    nombre: 'Terminal ISO 8583',   url: '/trama.html',              icon: '⚡' },
    { id: 'monitor',  nombre: 'Monitor de Puertos',  url: '/monitor-de-puerto.html',  icon: '📡' },
    { id: 'perfiles', nombre: 'Gestión de Perfiles', url: '/perfil.html',             icon: '👥' },
];

app.get('/api/modulos', (req, res) => {
    res.json(MODULOS_SISTEMA);
});

// ============================================================
// RESEND — instancia lazy para no crashear al arrancar
// ============================================================
function getResend() {
    const key = process.env.RESEND_API_KEY;
    if (!key) throw new Error('RESEND_API_KEY no definida');
    return new Resend(key);
}

async function enviarClaveEmail(email, username, tempPass) {
    const client = getResend();
    const { data, error } = await client.emails.send({
        from: 'Visual Admin <onboarding@resend.dev>',
        to: email,
        subject: 'Acceso al Sistema - Clave Temporal',
        html: `<h3>Bienvenido al Sistema</h3>
               <p>Se ha creado tu perfil de usuario:</p>
               <ul>
                 <li><strong>Usuario:</strong> ${username}</li>
                 <li><strong>Clave Temporal:</strong> ${tempPass}</li>
               </ul>
               <p>Deberás cambiarla en tu primer ingreso.</p>`
    });
    if (error) throw new Error(error.message);
    return data;
}

if (!process.env.RESEND_API_KEY) {
    console.warn('⚠️  RESEND_API_KEY no definida — correos deshabilitados');
} else {
    console.log('✅ Resend configurado correctamente');
}

// ============================================================
// MIGRACIÓN — agregar columna modulos si no existe
// ============================================================
async function migrarDB() {
    try {
        await db.query(`
            ALTER TABLE usuarios
            ADD COLUMN IF NOT EXISTS modulos TEXT DEFAULT '[]'
        `);
        console.log('✅ Columna modulos verificada/creada');
    } catch (err) {
        console.warn('⚠️  Migración modulos:', err.message);
    }
}
setTimeout(migrarDB, 2000);

// ============================================================
// RUTAS API
// ============================================================

// 1. LOGIN — devuelve modulos para que el dashboard los use
app.post('/api/login', async (req, res) => {
    const { user, pass } = req.body;
    try {
        const usuario = await db.get(
            'SELECT * FROM usuarios WHERE username = $1 OR email = $1', [user]
        );
        if (!usuario) return res.status(404).json({ ok: false, msg: 'Usuario no existe' });
        if (usuario.estado === 'INACTIVO')
            return res.status(403).json({ ok: false, msg: 'Cuenta desactivada.' });
        if (usuario.password !== pass)
            return res.status(401).json({ ok: false, msg: 'Contraseña incorrecta' });

        let modulos = [];
        try {
            modulos = typeof usuario.modulos === 'string'
                ? JSON.parse(usuario.modulos)
                : (usuario.modulos || []);
        } catch { modulos = []; }

        // ADMIN y Administrador ven todos los módulos
        const esAdmin = ['ADMIN', 'Administrador'].includes(usuario.rol);
        if (esAdmin) modulos = MODULOS_SISTEMA.map(m => m.id);

        res.json({
            ok: true,
            user: {
                username:        usuario.username,
                nombre:          usuario.nombre,
                rol:             usuario.rol,
                requiere_cambio: usuario.requiere_cambio,
                modulos
            }
        });
    } catch (error) {
        res.status(500).json({ ok: false, msg: 'Error en el servidor' });
    }
});

// 2. OBTENER USUARIOS
app.get('/api/usuarios', async (req, res) => {
    try {
        const rows = await db.all(
            'SELECT nombre, username, email, rol, nodos, modulos, estado FROM usuarios ORDER BY id DESC'
        );
        const usuarios = rows.map(u => ({
            ...u,
            nodos:   typeof u.nodos   === 'string' ? JSON.parse(u.nodos   || '[]') : (u.nodos   || []),
            modulos: typeof u.modulos === 'string' ? JSON.parse(u.modulos || '[]') : (u.modulos || [])
        }));
        res.json(usuarios);
    } catch (error) {
        res.status(500).json({ ok: false, msg: 'Error al obtener usuarios' });
    }
});

// 3. CREAR USUARIO
app.post('/api/usuarios', async (req, res) => {
    const { nombre, user, email, rol, nodos, modulos, password, requiere_cambio, estado } = req.body;
    try {
        const sql = `INSERT INTO usuarios
            (nombre, username, email, rol, nodos, modulos, password, requiere_cambio, estado)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`;
        await db.query(sql, [
            nombre, user, email, rol,
            JSON.stringify(nodos   || []),
            JSON.stringify(modulos || []),
            password, requiere_cambio, estado
        ]);
        console.log(`✅ Usuario ${user} creado`);
        res.json({ ok: true });

        enviarClaveEmail(email, user, password)
            .then(() => console.log(`✅ Email enviado a ${email}`))
            .catch(err => console.error(`⚠️  Email falló: ${err.message}`));
    } catch (error) {
        console.error('❌ Error al crear usuario:', error.message);
        res.status(500).json({ ok: false, msg: error.message });
    }
});

// 4. CAMBIAR ESTADO
app.patch('/api/usuarios/:username/estado', async (req, res) => {
    const { username } = req.params;
    const { estado } = req.body;
    try {
        await db.query('UPDATE usuarios SET estado=$1 WHERE username=$2', [estado, username]);
        res.json({ ok: true });
    } catch { res.status(500).json({ ok: false }); }
});

// 5. ACTUALIZAR MÓDULOS DE UN USUARIO
app.patch('/api/usuarios/:username/modulos', async (req, res) => {
    const { username } = req.params;
    const { modulos } = req.body;
    try {
        await db.query(
            'UPDATE usuarios SET modulos=$1 WHERE username=$2',
            [JSON.stringify(modulos || []), username]
        );
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ ok: false, msg: error.message });
    }
});

// 6. ELIMINAR USUARIO
app.delete('/api/usuarios/:username', async (req, res) => {
    const { username } = req.params;
    try {
        await db.query('DELETE FROM usuarios WHERE username=$1', [username]);
        res.json({ ok: true });
    } catch { res.status(500).json({ ok: false }); }
});

// 7. ACTUALIZAR CONTRASEÑA
app.post('/api/update-password', async (req, res) => {
    const { username, currentPassword, newPassword } = req.body;
    try {
        const user = await db.get('SELECT * FROM usuarios WHERE username=$1', [username]);
        if (!user || user.password !== currentPassword)
            return res.status(401).json({ ok: false, msg: 'Clave temporal incorrecta' });
        await db.query(
            'UPDATE usuarios SET password=$1, requiere_cambio=0 WHERE username=$2',
            [newPassword, username]
        );
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ ok: false, msg: 'Error al actualizar' });
    }
});

// 8. REENVIAR CLAVE
app.post('/api/usuarios/:username/reenviar-clave', async (req, res) => {
    const { username } = req.params;
    const { email } = req.body;
    const nuevaClave = crypto.randomBytes(4).toString('hex').toUpperCase();
    try {
        await db.query(
            'UPDATE usuarios SET password=$1, requiere_cambio=1 WHERE username=$2',
            [nuevaClave, username]
        );
        res.json({ ok: true });
        enviarClaveEmail(email, username, nuevaClave)
            .then(() => console.log(`✅ Clave reenviada a ${email}`))
            .catch(err => console.error(`⚠️  Reenvío falló: ${err.message}`));
    } catch (error) {
        res.status(500).json({ ok: false, msg: 'Error al reenviar' });
    }
});

// ============================================================
// MONITOR DE NODOS — PING AS/400
// ============================================================
app.post('/api/monitor/ping', async (req, res) => {
    const { nodo } = req.body;
    if (!nodo) return res.status(400).json({ ok: false, msg: 'Nodo requerido' });
    const AS400_URL = process.env.AS400_RELAY_URL || 'http://172.23.12.2:10022/web/services/CRUD_PR01/prueba1';
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), 5000);
    try {
        const t0 = Date.now();
        const response = await fetch(AS400_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'bypass-tunnel-reminder': 'true' },
            body: JSON.stringify({ id_transaccion: 'PING', nodo, idx: '00' }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        const latencia = Date.now() - t0;
        if (response.ok || response.status < 500) {
            return res.json({ ok: true, nodo, latencia });
        }
        return res.json({ ok: false, nodo, latencia, msg: `HTTP ${response.status}` });
    } catch (err) {
        clearTimeout(timeoutId);
        return res.status(200).json({ ok: false, nodo, msg: err.name === 'AbortError' ? 'TIMEOUT' : err.message });
    }
});

// ============================================================
// TERMINAL ISO 8583
// ============================================================
app.post('/api/ejecutar-trarput', async (req, res) => {
    const { idtx, nodx, modx } = req.body;
    const AS400_URL = process.env.AS400_RELAY_URL || 'http://172.23.12.2:10022/web/services/CRUD_PR01/prueba1';
    console.log(`📡 Reenviando petición a: ${AS400_URL}`);
    try {
        const response = await fetch(AS400_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'bypass-tunnel-reminder': 'true' },
            body: JSON.stringify({ id_transaccion: idtx, nodo: nodx, idx: modx })
        });
        const rawText = await response.text();
        let parsed;
        try { parsed = JSON.parse(rawText); } catch { parsed = { rawData: rawText }; }
        if (parsed.data && typeof parsed.data === 'string') {
            try { parsed.data = JSON.parse(parsed.data); } catch { /* string */ }
        }
        res.status(response.status).json({ ok: response.ok, ...parsed });
    } catch (err) {
        res.status(500).json({ ok: false, msg: `Error de conexión: ${err.message}` });
    }
});

// ============================================================
// MONITOR DE PUERTOS TCP
// ============================================================
const PUERTOS_AS400 = [
    { puerto: 34021, nombre: 'Pagos Movistar',     job: 'AISMO34021' },
    { puerto: 34022, nombre: 'Pagos Digitel',       job: 'AISDI34022' },
    { puerto: 34023, nombre: 'Pagos Movilnet',      job: 'AISMV34023' },
    { puerto: 34024, nombre: 'Cierre Aisino',       job: 'AISCI34024' },
    { puerto: 34025, nombre: 'Pagos Wifi',          job: 'AISWI34025' },
    { puerto: 34026, nombre: 'Recarga Digitel/Ekk', job: 'AISRD34026' },
];

const portState = {};
PUERTOS_AS400.forEach(p => {
    portState[p.puerto] = { puerto: p.puerto, nombre: p.nombre, job: p.job,
        status: 'unknown', desde: null, downSince: null, ultimoUp: null, eventos: [] };
});

const sseClients = new Set();

function checkPort(ip, puerto, timeoutMs = 4000) {
    return new Promise((resolve) => {
        const t0 = Date.now(), socket = new net.Socket();
        let done = false;
        const finish = (up, err) => {
            if (done) return; done = true; socket.destroy();
            resolve({ up, latencia: Date.now() - t0, error: err || null });
        };
        socket.setTimeout(timeoutMs);
        socket.connect(puerto, ip, () => finish(true, null));
        socket.on('error', e => finish(false, e.message));
        socket.on('timeout', () => finish(false, 'TCP timeout'));
    });
}

function actualizarEstado(puerto, resultado) {
    const s = portState[puerto], ahora = Date.now();
    const wasUp = s.status === 'up', isUp = resultado.up;
    if (isUp && !wasUp) {
        const dur = s.downSince ? ahora - s.downSince : 0;
        s.eventos.unshift({ ts: ahora, tipo: 'recovery', duracion: dur });
        if (s.eventos.length > 50) s.eventos.pop();
        s.status = 'up'; s.ultimoUp = ahora; s.downSince = null; s.desde = ahora;
        console.log(`✅ Puerto ${puerto} RECUPERADO · ${Math.round(dur/1000)}s caído`);
    } else if (!isUp && wasUp) {
        s.eventos.unshift({ ts: ahora, tipo: 'down', error: resultado.error });
        if (s.eventos.length > 50) s.eventos.pop();
        s.status = 'down'; s.downSince = ahora; s.desde = ahora;
        console.warn(`❌ Puerto ${puerto} CAÍDO`);
    } else if (s.status === 'unknown') {
        s.status = isUp ? 'up' : 'down'; s.desde = ahora;
        if (!isUp) s.downSince = ahora;
    }
    s.latencia = resultado.latencia;
}

async function cicloMonitor() {
    const ip = process.env.AS400_IP || '172.23.12.2';
    await Promise.allSettled(PUERTOS_AS400.map(async ({ puerto }) => {
        const resultado = await checkPort(ip, puerto);
        actualizarEstado(puerto, resultado);
    }));
    broadcastSSE({ tipo: 'update', data: Object.values(portState) });
}

function broadcastSSE(payload) {
    const msg = `data: ${JSON.stringify(payload)}

`;
    sseClients.forEach(res => { try { res.write(msg); } catch { sseClients.delete(res); } });
}

setTimeout(() => { cicloMonitor(); setInterval(cicloMonitor, 10000); }, 3000);

app.get('/api/monitor/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ tipo: 'init', data: Object.values(portState) })}

`);
    sseClients.add(res);
    console.log(`📡 SSE cliente · total: ${sseClients.size}`);
    req.on('close', () => { sseClients.delete(res); });
});

app.get('/api/monitor/estado', (req, res) => res.json(Object.values(portState)));

// ============================================================
// INICIO DEL SERVIDOR
// ============================================================
const SERVER_PORT = process.env.PORT || 3001;
app.listen(SERVER_PORT, () => {
    console.log("===============================================");
    console.log(`🚀 Visual Admin activo en puerto: ${SERVER_PORT}`);
    console.log("===============================================");
});

// ============================================================
// INICIALIZAR ADMIN
// ============================================================
const inicializarAdmin = async () => {
    try {
        const existe = await db.get('SELECT * FROM usuarios WHERE username=$1', ['admin']);
        if (!existe) {
            await db.query(
                `INSERT INTO usuarios (nombre,username,email,rol,nodos,modulos,password,requiere_cambio,estado)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
                ['Administrador','admin', process.env.MAIL_USER || 'admin@sistema.com',
                 'ADMIN','[]', JSON.stringify(['trama','monitor','perfiles']),
                 'admin123', 0, 'ACTIVO']
            );
            console.log('👤 USUARIO ADMIN CREADO');
        }
    } catch (err) { console.error('❌ Error init:', err.message); }
};
setTimeout(inicializarAdmin, 7000);

// ============================================================
// KEEP ALIVE
// ============================================================
const https = require('https');
setInterval(() => {
    https.get('https://visual-admin-prueba.onrender.com', r => {
        console.log(`Keep alive: ${r.statusCode}`);
    }).on('error', e => console.log('Keep alive error:', e.message));
}, 4 * 60 * 1000);
