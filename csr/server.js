const express = require('express');
const cors    = require('cors');
const path    = require('path');
const crypto  = require('crypto');
const nodemailer = require('nodemailer');
const db = require('./database');
const os = require('os');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json());

// --- CONFIGURACIÓN DE ARCHIVOS ESTÁTICOS ---
app.use(express.static(path.join(__dirname, 'public')));

// --- RUTA RAÍZ ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// ============================================================
// CONFIGURACIÓN DE CORREO (Nodemailer)
// ============================================================
const mailConfig = {
    host:   process.env.MAIL_HOST || 'smtp.gmail.com',
    port:   process.env.MAIL_PORT || 587,
    secure: false,
    auth: {
        user: process.env.MAIL_USER || 'lfranciscowa@gmail.com',
        pass: process.env.MAIL_PASS || 'qhuahqcuelcwstff'
    }
};
const transporter = nodemailer.createTransport(mailConfig);

async function enviarClaveEmail(email, username, tempPass) {
    const mailOptions = {
        from: `"Visual Admin" <${mailConfig.auth.user}>`,
        to: email,
        subject: 'Acceso al Sistema - Clave Temporal',
        html: `<h3>Bienvenido al Sistema</h3>
               <p>Se ha creado tu perfil de usuario:</p>
               <ul>
                 <li><strong>Usuario:</strong> ${username}</li>
                 <li><strong>Clave Temporal:</strong> ${tempPass}</li>
               </ul>
               <p>Deberás cambiarla en tu primer ingreso.</p>`
    };
    return transporter.sendMail(mailOptions);
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
app.post('/api/usuarios', async (req, res) => {
    const { nombre, user, email, rol, nodos, password, requiere_cambio, estado } = req.body;
    try {
        const sql = `INSERT INTO usuarios (nombre, username, email, rol, nodos, password, requiere_cambio, estado) 
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;
        await db.query(sql, [nombre, user, email, rol, JSON.stringify(nodos), password, requiere_cambio, estado]);
        await enviarClaveEmail(email, user, password);
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ ok: false, msg: "Error al crear usuario" });
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
        await enviarClaveEmail(email, username, nuevaClave);
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ ok: false, msg: "Error al reenviar" });
    }
});

// ============================================================
// COMUNICACIÓN CON AS/400 (TERMINAL ISO 8583)
// ============================================================
app.post('/api/ejecutar-trarput', async (req, res) => {
    const { idtx, nodx, modx } = req.body;

    const baseUrl = process.env.API_BASE_URL || 'http://172.23.12.2:10022';
    const AS400_URL = `${baseUrl}/web/services/CRUD_PR01/prueba1`;

    console.log(`📡 Reenviando petición a: ${AS400_URL}`);

    try {
        const response = await fetch(AS400_URL, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                // AJUSTE: Saltamos la advertencia de Serveo para que el fetch no falle
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
        try {
            parsed = JSON.parse(rawText);
        } catch {
            parsed = { rawData: rawText };
        }

        if (parsed.data && typeof parsed.data === 'string') {
            try {
                parsed.data = JSON.parse(parsed.data);
            } catch {
                // mantener como string
            }
        }

        res.status(response.status).json({ ok: response.ok, ...parsed });

    } catch (err) {
        console.error('❌ Error en el túnel:', err.message);
        res.status(500).json({ ok: false, msg: `Error de conexión: ${err.message}` });
    }
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
                ['Administrador', 'admin', 'lfranciscowa@gmail.com', 'ADMIN', '[]', 'admin123', 0, 'ACTIVO']
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