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
// CONFIGURACIÓN DE CORREO (Resend — funciona en Render via HTTPS)
// ============================================================
// ✅ Resend usa HTTP en vez de SMTP, evitando el bloqueo de Render

async function enviarClaveEmail(email, username, tempPass) {
    const { data, error } = await resend.emails.send({
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

// Verificar API key al arrancar
if (!process.env.RESEND_API_KEY) {
    console.error('❌ RESEND_API_KEY no definida en variables de entorno');
} else {
    console.log('✅ Resend configurado correctamente');
}

// ============================================================
// RUTAS DE LA API (POSTGRESQL)
// ============================================================

// 1. LOGIN
app.post('/api/login', async (req, res) => {
    const { user, pass } = req.body;
    try {
        const usuario = await db.get('SELECT * FROM usuarios WHERE username = $1 OR email = $1', [user]);
        if (usuario) {
            if (usuario.estado === 'INACTIVO') {
                return res.status(403).json({ ok: false, msg: "Cuenta desactivada." });
            }
            if (usuario.password === pass) {
                res.json({
                    ok: true,
                    user: { username: usuario.username, rol: usuario.rol, requiere_cambio: usuario.requiere_cambio }
                });
            } else {
                res.status(401).json({ ok: false, msg: "Contraseña incorrecta" });
            }
        } else {
            res.status(404).json({ ok: false, msg: "Usuario no existe" });
        }
    } catch (error) {
        res.status(500).json({ ok: false, msg: "Error en el servidor" });
    }
});

// 2. OBTENER USUARIOS
app.get('/api/usuarios', async (req, res) => {
    try {
        const rows = await db.all('SELECT nombre, username, email, rol, nodos, estado FROM usuarios ORDER BY id DESC');
        const usuarios = rows.map(u => ({
            ...u,
            nodos: typeof u.nodos === 'string' ? JSON.parse(u.nodos) : u.nodos
        }));
        res.json(usuarios);
    } catch (error) {
        res.status(500).json({ ok: false, msg: "Error al obtener usuarios" });
    }
});

// 3. CREAR USUARIO
// ✅ FIX PRINCIPAL: Responde al cliente inmediatamente y envía el email en segundo plano
app.post('/api/usuarios', async (req, res) => {
    const { nombre, user, email, rol, nodos, password, requiere_cambio, estado } = req.body;
    try {
        const sql = `INSERT INTO usuarios (nombre, username, email, rol, nodos, password, requiere_cambio, estado) 
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;
        await db.query(sql, [nombre, user, email, rol, JSON.stringify(nodos), password, requiere_cambio, estado]);
        console.log(`✅ Usuario ${user} creado en DB`);

        // ✅ FIX: Responder ANTES de enviar el correo — el cliente no espera el SMTP
        res.json({ ok: true });

        // Envío en segundo plano (no bloquea la respuesta)
        enviarClaveEmail(email, user, password)
            .then(() => console.log(`✅ Email enviado a ${email}`))
            .catch(err => console.error(`⚠️  Email falló para ${user} (${email}):`, err.message));

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
        await db.query('UPDATE usuarios SET estado = $1 WHERE username = $2', [estado, username]);
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ ok: false });
    }
});

// 5. ELIMINAR USUARIO
app.delete('/api/usuarios/:username', async (req, res) => {
    const { username } = req.params;
    try {
        await db.query('DELETE FROM usuarios WHERE username = $1', [username]);
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ ok: false });
    }
});

// 6. ACTUALIZAR CONTRASEÑA
app.post('/api/update-password', async (req, res) => {
    const { username, currentPassword, newPassword } = req.body;
    try {
        const user = await db.get('SELECT * FROM usuarios WHERE username = $1', [username]);
        if (!user || user.password !== currentPassword) {
            return res.status(401).json({ ok: false, msg: "Clave temporal incorrecta" });
        }
        await db.query('UPDATE usuarios SET password = $1, requiere_cambio = 0 WHERE username = $2', [newPassword, username]);
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ ok: false, msg: "Error al actualizar" });
    }
});

// 7. REENVIAR CLAVE
app.post('/api/usuarios/:username/reenviar-clave', async (req, res) => {
    const { username } = req.params;
    const { email } = req.body;
    const nuevaClave = crypto.randomBytes(4).toString('hex').toUpperCase();
    try {
        await db.query('UPDATE usuarios SET password = $1, requiere_cambio = 1 WHERE username = $2', [nuevaClave, username]);

        // ✅ FIX: También responder primero en reenvío de clave
        res.json({ ok: true });

        enviarClaveEmail(email, username, nuevaClave)
            .then(() => console.log(`✅ Clave reenviada a ${email}`))
            .catch(err => console.error(`⚠️  Reenvío falló para ${username}:`, err.message));

    } catch (error) {
        res.status(500).json({ ok: false, msg: "Error al reenviar" });
    }
});


// ============================================================
// MONITOR DE NODOS — PING AS/400
// ============================================================
// Envía una transacción liviana a cada nodo y mide respuesta.
// Si el AS/400 responde (cualquier HTTP 2xx), el nodo está ACTIVO.
// Si hay timeout o error de red, está INACTIVO/TIMEOUT.

app.post('/api/monitor/ping', async (req, res) => {
    const { nodo } = req.body;
    if (!nodo) return res.status(400).json({ ok: false, msg: 'Nodo requerido' });

    const AS400_URL = process.env.AS400_RELAY_URL
        || 'http://172.23.12.2:10022/web/services/CRUD_PR01/prueba1';

    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), 5000);

    try {
        const t0 = Date.now();
        const response = await fetch(AS400_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'bypass-tunnel-reminder': 'true'
            },
            body: JSON.stringify({
                id_transaccion: 'PING',   // Transacción de healthcheck
                nodo:           nodo,
                idx:            '00'
            }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        const latencia = Date.now() - t0;
        const rawText  = await response.text();

        // Cualquier respuesta HTTP del AS/400 = nodo activo
        if (response.ok || response.status < 500) {
            console.log(`✅ PING OK nodo ${nodo} · ${latencia}ms`);
            return res.json({ ok: true, nodo, latencia });
        } else {
            console.warn(`⚠️  PING FAIL nodo ${nodo} · HTTP ${response.status}`);
            return res.json({ ok: false, nodo, latencia, msg: `HTTP ${response.status}` });
        }

    } catch (err) {
        clearTimeout(timeoutId);
        const esTimeout = err.name === 'AbortError';
        console.warn(`❌ PING ${esTimeout ? 'TIMEOUT' : 'ERROR'} nodo ${nodo}: ${err.message}`);
        return res.status(200).json({
            ok:  false,
            nodo,
            msg: esTimeout ? 'TIMEOUT' : err.message
        });
    }
});

// ============================================================
// COMUNICACIÓN CON AS/400 (TERMINAL ISO 8583)
// ============================================================
app.post('/api/ejecutar-trarput', async (req, res) => {
    const { idtx, nodx, modx } = req.body;

    const AS400_URL = process.env.AS400_RELAY_URL 
    || 'http://172.23.12.2:10022/web/services/CRUD_PR01/prueba1'; 

    console.log(`📡 Reenviando petición a: ${AS400_URL}`);

    try {
        const response = await fetch(AS400_URL, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'bypass-tunnel-reminder': 'true' 
            },
            body: JSON.stringify({
                id_transaccion: idtx,
                nodo: nodx,
                idx: modx
            })
        });

        const rawText = await response.text();
        let parsed;
        try { parsed = JSON.parse(rawText); }
        catch { parsed = { rawData: rawText }; }

        if (parsed.data && typeof parsed.data === 'string') {
            try { parsed.data = JSON.parse(parsed.data); }
            catch { /* mantener como string */ }
        }

        res.status(response.status).json({ ok: response.ok, ...parsed });

    } catch (err) {
        console.error('❌ Error en el túnel:', err.message);
        res.status(500).json({ ok: false, msg: `Error de conexión: ${err.message}` });
    }
});


// ============================================================
// MONITOR DE PUERTOS TCP — AS/400 SOCKET SERVERS
// ============================================================
// Usa net.createConnection() para verificar si cada puerto
// acepta conexiones TCP (igual que lo hace el AS/400 con select()).
// La IP se configura por ambiente via AS400_IP en .env / Render.

const PUERTOS_AS400 = [
    { puerto: 34021, nombre: 'Pagos Movistar',       job: 'AISMO34021' },
    { puerto: 34022, nombre: 'Pagos Digitel',         job: 'AISDI34022' },
    { puerto: 34023, nombre: 'Pagos Movilnet',        job: 'AISMV34023' },
    { puerto: 34024, nombre: 'Cierre Aisino',         job: 'AISCI34024' },
    { puerto: 34025, nombre: 'Pagos Wifi',            job: 'AISWI34025' },
    { puerto: 34026, nombre: 'Recarga Digitel/Ekk',   job: 'AISRD34026' },
];

// Estado en memoria de cada puerto
const portState = {};
PUERTOS_AS400.forEach(p => {
    portState[p.puerto] = {
        puerto:    p.puerto,
        nombre:    p.nombre,
        job:       p.job,
        status:    'unknown',     // up | down | unknown
        desde:     null,          // timestamp del último cambio de estado
        downSince: null,          // timestamp cuando cayó (null si está UP)
        ultimoUp:  null,          // timestamp del último recovery
        eventos:   [],            // historial [{ts, tipo, duracion}]
    };
});

// Clientes SSE conectados
const sseClients = new Set();

// Verificar un puerto TCP con timeout
function checkPort(ip, puerto, timeoutMs = 4000) {
    return new Promise((resolve) => {
        const t0     = Date.now();
        const socket = new net.Socket();
        let done     = false;

        const finish = (up, err) => {
            if (done) return;
            done = true;
            socket.destroy();
            resolve({ up, latencia: Date.now() - t0, error: err || null });
        };

        socket.setTimeout(timeoutMs);
        socket.connect(puerto, ip, () => finish(true, null));
        socket.on('error',   (e) => finish(false, e.message));
        socket.on('timeout', ()  => finish(false, 'TCP timeout'));
    });
}

// Actualizar estado y emitir eventos SSE si hubo cambio
function actualizarEstado(puerto, resultado) {
    const s      = portState[puerto];
    const ahora  = Date.now();
    const wasUp  = s.status === 'up';
    const isUp   = resultado.up;

    if (isUp && !wasUp) {
        // Recuperación
        const duracionCaida = s.downSince ? ahora - s.downSince : 0;
        s.eventos.unshift({ ts: ahora, tipo: 'recovery', duracion: duracionCaida });
        if (s.eventos.length > 50) s.eventos.pop();
        s.status    = 'up';
        s.ultimoUp  = ahora;
        s.downSince = null;
        s.desde     = ahora;
        console.log(`✅ Puerto ${puerto} RECUPERADO · estuvo caído ${Math.round(duracionCaida/1000)}s`);

    } else if (!isUp && wasUp) {
        // Caída
        s.eventos.unshift({ ts: ahora, tipo: 'down', error: resultado.error });
        if (s.eventos.length > 50) s.eventos.pop();
        s.status    = 'down';
        s.downSince = ahora;
        s.desde     = ahora;
        console.warn(`❌ Puerto ${puerto} CAÍDO: ${resultado.error}`);

    } else if (s.status === 'unknown') {
        s.status    = isUp ? 'up' : 'down';
        s.desde     = ahora;
        if (!isUp) s.downSince = ahora;
    }

    s.latencia = resultado.latencia;
}

// Ciclo de verificación cada 10 segundos
async function cicloMonitor() {
    const ip = process.env.AS400_IP || '172.23.12.2';
    await Promise.allSettled(
        PUERTOS_AS400.map(async ({ puerto }) => {
            const resultado = await checkPort(ip, puerto);
            actualizarEstado(puerto, resultado);
        })
    );
    // Emitir estado actualizado a todos los clientes SSE
    broadcastSSE({ tipo: 'update', data: Object.values(portState) });
}

function broadcastSSE(payload) {
    const msg = `data: ${JSON.stringify(payload)}\n\n`;
    sseClients.forEach(res => {
        try { res.write(msg); } catch (_) { sseClients.delete(res); }
    });
}

// Iniciar ciclo al arrancar (esperar 3s para que el server esté listo)
setTimeout(() => {
    cicloMonitor();
    setInterval(cicloMonitor, 10000);
}, 3000);

// SSE endpoint — el browser se suscribe aquí
app.get('/api/monitor/stream', (req, res) => {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.flushHeaders();

    // Enviar estado actual inmediatamente al conectar
    res.write(`data: ${JSON.stringify({ tipo: 'init', data: Object.values(portState) })}\n\n`);

    sseClients.add(res);
    console.log(`📡 SSE cliente conectado · total: ${sseClients.size}`);

    req.on('close', () => {
        sseClients.delete(res);
        console.log(`📡 SSE cliente desconectado · total: ${sseClients.size}`);
    });
});

// GET snapshot puntual (para carga inicial sin SSE)
app.get('/api/monitor/estado', (req, res) => {
    res.json(Object.values(portState));
});

// ============================================================
// INICIO DEL SERVIDOR
// ============================================================
const SERVER_PORT = process.env.PORT || 3001;
app.listen(SERVER_PORT, () => {
    console.log("===============================================");
    console.log(`🚀 Servidor Visual Admin activo en puerto: ${SERVER_PORT}`);
    console.log(`✅ Conectado a Neon PostgreSQL`);
    console.log("===============================================");
});

// ============================================================
// INICIALIZAR ADMIN
// ============================================================
const inicializarAdmin = async () => {
    try {
        const existe = await db.get('SELECT * FROM usuarios WHERE username = $1', ['admin']);
        if (!existe) {
            await db.query(
                `INSERT INTO usuarios (nombre, username, email, rol, nodos, password, requiere_cambio, estado) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                ['Administrador', 'admin', process.env.MAIL_USER, 'ADMIN', '[]', 'admin123', 0, 'ACTIVO']
            );
            console.log('👤 USUARIO ADMIN CREADO EXITOSAMENTE');
        } else {
            console.log('👤 El usuario admin ya existe en la base de datos.');
        }
    } catch (err) {
        console.error('❌ Error en inicialización:', err.message);
    }
};

setTimeout(inicializarAdmin, 7000);

// ============================================================
// KEEP ALIVE — evita que Render se duerma
// ============================================================
const https = require('https');
setInterval(() => {
    https.get('https://visual-admin-prueba.onrender.com', (res) => {
        console.log(`Keep alive: ${res.statusCode}`);
    }).on('error', (e) => {
        console.log('Keep alive error:', e.message);
    });
}, 4 * 60 * 1000);
