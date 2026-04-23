const express = require('express');
const cors    = require('cors');
const path    = require('path');
const crypto  = require('crypto');
const nodemailer = require('nodemailer');
const { inicializarTablas } = require('./database');
const os = require('os');

const app = express();


app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

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

// URL base del sistema (ajusta si usas dominio propio)
const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';

// ============================================================
// EMAIL 1: Nuevo usuario — clave temporal + link al login
// ============================================================
async function enviarClaveEmail({ destinatario, username, tempPassword }) {
    // La clave expira en 24 horas → se marca en el correo
    const loginURL = `${BASE_URL}/login.html`;

    const mailOptions = {
        from:    `"Visual Admin" <${mailConfig.auth.user}>`,
        to:      destinatario,
        subject: '🔑 Tu acceso al sistema Visual Admin',
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; background: #f8f7ff; border-radius: 16px; overflow: hidden;">
                <div style="background: linear-gradient(135deg, #6d28d9, #8b5cf6); padding: 32px; text-align: center;">
                    <h1 style="color: white; margin: 0; font-size: 24px;">Visual Admin</h1>
                    <p style="color: rgba(255,255,255,0.8); margin: 8px 0 0 0; font-size: 14px;">Sistema de administración bancaria</p>
                </div>
                <div style="padding: 32px; background: white;">
                    <h2 style="color: #1e1b4b; margin-top: 0;">¡Bienvenido al sistema!</h2>
                    <p style="color: #475569; font-size: 14px; line-height: 1.6;">
                        Se ha creado una cuenta de acceso para ti. Usa las siguientes credenciales para iniciar sesión:
                    </p>
                    <div style="background: #f5f3ff; border: 1px solid #ddd6fe; border-radius: 10px; padding: 20px; margin: 20px 0; text-align: center;">
                        <p style="margin: 0 0 8px 0; font-size: 12px; color: #7c3aed; font-weight: 700; text-transform: uppercase;">Usuario</p>
                        <p style="margin: 0 0 16px 0; font-size: 22px; font-weight: 700; color: #1e1b4b; font-family: monospace;">${username}</p>
                        <p style="margin: 0 0 8px 0; font-size: 12px; color: #7c3aed; font-weight: 700; text-transform: uppercase;">Clave temporal</p>
                        <p style="margin: 0; font-size: 26px; font-weight: 700; color: #059669; font-family: monospace; letter-spacing: 2px;">${tempPassword}</p>
                    </div>

                    <!-- ALERTA 24 HORAS -->
                    <div style="background: #fff7ed; border: 1px solid #fed7aa; border-radius: 8px; padding: 14px; margin-bottom: 20px;">
                        <p style="margin: 0; font-size: 13px; color: #9a3412;">
                            ⏰ <strong>Esta clave temporal expira en 24 horas.</strong><br>
                            Debes ingresar y cambiarla antes de que venza.
                        </p>
                    </div>

                    <!-- ALERTA PRIMER INGRESO -->
                    <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 14px; margin-bottom: 24px;">
                        <p style="margin: 0; font-size: 13px; color: #92400e;">
                            ⚠️ <strong>Primer ingreso:</strong> El sistema te pedirá que establezcas una nueva contraseña personal antes de continuar.
                        </p>
                    </div>

                    <!-- BOTÓN DE ACCESO -->
                    <div style="text-align: center; margin: 28px 0;">
                        <a href="${loginURL}"
                           style="display: inline-block; background: linear-gradient(135deg, #7c3aed, #8b5cf6);
                                  color: white; text-decoration: none; padding: 14px 32px;
                                  border-radius: 12px; font-weight: 700; font-size: 15px;
                                  box-shadow: 0 6px 20px rgba(109,40,217,0.35);">
                            🔐 Ir al sistema
                        </a>
                        <p style="margin: 10px 0 0 0; font-size: 11px; color: #94a3b8;">
                            O copia este enlace: <a href="${loginURL}" style="color: #7c3aed;">${loginURL}</a>
                        </p>
                    </div>

                    <p style="color: #64748b; font-size: 13px;">Si no esperabas este correo, ignóralo o contacta al administrador del sistema.</p>
                </div>
                <div style="padding: 16px 32px; background: #f8fafc; text-align: center;">
                    <p style="color: #94a3b8; font-size: 11px; margin: 0;">Visual Admin v2.0 · Infraestructura de monitoreo bancario</p>
                </div>
            </div>
        `
    };

    await transporter.sendMail(mailOptions);
}

// ============================================================
// EMAIL 2: Enlace de reset por token (reenvío de clave)
// ============================================================
async function enviarEnlaceReset({ destinatario, username, token }) {
    const resetURL = `${BASE_URL}/cambiar-clave.html?token=${token}`;

    const mailOptions = {
        from:    `"Visual Admin" <${mailConfig.auth.user}>`,
        to:      destinatario,
        subject: '🔗 Restablecimiento de contraseña — Visual Admin',
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; background: #f8f7ff; border-radius: 16px; overflow: hidden;">
                <div style="background: linear-gradient(135deg, #6d28d9, #8b5cf6); padding: 32px; text-align: center;">
                    <h1 style="color: white; margin: 0; font-size: 24px;">Visual Admin</h1>
                    <p style="color: rgba(255,255,255,0.8); margin: 8px 0 0 0; font-size: 14px;">Restablecimiento de acceso</p>
                </div>
                <div style="padding: 32px; background: white;">
                    <h2 style="color: #1e1b4b; margin-top: 0;">Cambio de contraseña solicitado</h2>
                    <p style="color: #475569; font-size: 14px; line-height: 1.6;">
                        Se ha solicitado un restablecimiento de contraseña para el usuario <strong style="font-family: monospace; color: #7c3aed;">${username}</strong>.
                    </p>

                    <!-- ALERTA 24 HORAS -->
                    <div style="background: #fff7ed; border: 1px solid #fed7aa; border-radius: 8px; padding: 14px; margin: 20px 0;">
                        <p style="margin: 0; font-size: 13px; color: #9a3412;">
                            ⏰ <strong>Este enlace expira en 24 horas.</strong><br>
                            Si no lo usas antes, deberás solicitar uno nuevo al administrador.
                        </p>
                    </div>

                    <div style="text-align: center; margin: 28px 0;">
                        <a href="${resetURL}"
                           style="display: inline-block; background: linear-gradient(135deg, #059669, #10b981);
                                  color: white; text-decoration: none; padding: 14px 32px;
                                  border-radius: 12px; font-weight: 700; font-size: 15px;
                                  box-shadow: 0 6px 20px rgba(5,150,105,0.35);">
                            🔒 Cambiar contraseña
                        </a>
                        <p style="margin: 10px 0 0 0; font-size: 11px; color: #94a3b8;">
                            O copia: <a href="${resetURL}" style="color: #059669; word-break: break-all;">${resetURL}</a>
                        </p>
                    </div>

                    <p style="color: #64748b; font-size: 13px;">Si no solicitaste este cambio, ignora este correo. Tu contraseña actual seguirá siendo la misma.</p>
                </div>
                <div style="padding: 16px 32px; background: #f8fafc; text-align: center;">
                    <p style="color: #94a3b8; font-size: 11px; margin: 0;">Visual Admin v2.0 · Infraestructura de monitoreo bancario</p>
                </div>
            </div>
        `
    };

    await transporter.sendMail(mailOptions);
}

// ============================================================
// HELPER: generar token aleatorio
// ============================================================
function generarToken() {
    return crypto.randomBytes(32).toString('hex');
}



// ============================================================
// 1. LOGIN
// ============================================================
app.post('/api/login', async (req, res) => {
    const { user, pass } = req.body;
    try {
        const usuario = await db.get(
            'SELECT * FROM usuarios WHERE username = ? AND password = ?',
            [user, pass]
        );
        if (usuario) {
            // Verificar si la clave temporal expiró (24 horas desde created_at cuando requiere_cambio=1)
            if (usuario.requiere_cambio === 1) {
                const createdAt  = new Date(usuario.created_at);
                const ahora      = new Date();
                const horasDesde = (ahora - createdAt) / (1000 * 60 * 60);

                if (horasDesde > 24) {
                    return res.status(401).json({
                        ok: false,
                        msg: "La clave temporal ha expirado (24 h). Contacta al administrador."
                    });
                }
            }

            res.json({
                ok: true,
                user: {
                    username:        usuario.username,
                    rol:             usuario.rol,
                    requiere_cambio: usuario.requiere_cambio
                }
            });
        } else {
            res.status(401).json({ ok: false, msg: "Credenciales inválidas" });
        }
    } catch (error) {
        res.status(500).json({ ok: false, msg: "Error de servidor" });
    }
});

// ============================================================
// 2. ACTUALIZAR CONTRASEÑA (primer ingreso — verifica clave temporal)
// ============================================================
app.post('/api/update-password', async (req, res) => {
    const { username, currentPassword, newPassword } = req.body;
    try {
        // Verificar que la clave actual (temporal) sea correcta
        const usuario = await db.get(
            'SELECT * FROM usuarios WHERE username = ? AND password = ?',
            [username, currentPassword]
        );

        if (!usuario) {
            return res.status(401).json({ ok: false, msg: "La clave temporal es incorrecta" });
        }

        await db.run(
            'UPDATE usuarios SET password = ?, requiere_cambio = 0 WHERE username = ?',
            [newPassword, username]
        );
        res.json({ ok: true, msg: "Contraseña actualizada correctamente" });
    } catch (error) {
        res.status(500).json({ ok: false, msg: "Error al actualizar contraseña" });
    }
});

// ============================================================
// 3. LISTAR USUARIOS
// ============================================================
app.get('/api/usuarios', async (req, res) => {
    try {
        const usuarios = await db.all('SELECT * FROM usuarios ORDER BY id DESC');
        const result = usuarios.map(u => ({
            ...u,
            nodos: u.nodos ? JSON.parse(u.nodos) : []
        }));
        res.json(result);
    } catch (error) {
        console.error("Error al obtener usuarios:", error);
        res.status(500).json({ ok: false, msg: "Error interno" });
    }
});

// ============================================================
// 4. CREAR USUARIO (correo con link + 24 h aviso)
// ============================================================
app.post('/api/usuarios', async (req, res) => {
    const { nombre, user, email, rol, nodos, password, requiere_cambio, estado } = req.body;

    try {
        const existe = await db.get('SELECT username FROM usuarios WHERE username = ?', [user]);
        if (existe) {
            return res.status(400).json({ ok: false, msg: "El nombre de usuario ya está en uso" });
        }

        await db.run(
            `INSERT INTO usuarios (nombre, username, email, password, rol, nodos, requiere_cambio, estado)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [nombre, user, email, password, rol, JSON.stringify(nodos || []), requiere_cambio ?? 1, estado || 'ACTIVO']
        );

        if (email) {
            try {
                await enviarClaveEmail({ destinatario: email, username: user, tempPassword: password });
                console.log(`📧 Correo enviado a ${email}`);
            } catch (mailErr) {
                console.warn("⚠️  No se pudo enviar el correo:", mailErr.message);
            }
        }

        res.json({ ok: true, msg: "Usuario creado exitosamente" });

    } catch (error) {
        console.error("Error al crear usuario:", error);
        res.status(500).json({ ok: false, msg: "Error interno al guardar en la base de datos" });
    }
});

// ============================================================
// 5. ACTIVAR / DESACTIVAR USUARIO
// ============================================================
app.patch('/api/usuarios/:username/estado', async (req, res) => {
    const { username } = req.params;
    const { estado } = req.body;

    if (!['ACTIVO', 'INACTIVO'].includes(estado)) {
        return res.status(400).json({ ok: false, msg: "Estado inválido" });
    }

    try {
        await db.run('UPDATE usuarios SET estado = ? WHERE username = ?', [estado, username]);
        res.json({ ok: true, msg: `Usuario ${estado}` });
    } catch (error) {
        res.status(500).json({ ok: false, msg: "Error al actualizar estado" });
    }
});

// ============================================================
// 6. ELIMINAR USUARIO
// ============================================================
app.delete('/api/usuarios/:username', async (req, res) => {
    const { username } = req.params;
    try {
        if (username.toLowerCase() === 'admin') {
            return res.status(403).json({ ok: false, msg: "No se puede eliminar al administrador principal" });
        }
        await db.run('DELETE FROM usuarios WHERE username = ?', [username]);
        res.json({ ok: true, msg: "Usuario eliminado" });
    } catch (error) {
        res.status(500).json({ ok: false, msg: "Error al eliminar usuario" });
    }
});

// ============================================================
// 7. REENVIAR CLAVE — genera token de reset (24 h)
// ============================================================
app.post('/api/usuarios/:username/reenviar-clave', async (req, res) => {
    const { username } = req.params;
    const { email }    = req.body;

    try {
        const usuario = await db.get('SELECT * FROM usuarios WHERE username = ?', [username]);
        if (!usuario) return res.status(404).json({ ok: false, msg: "Usuario no encontrado" });

        // Invalidar tokens anteriores
        await db.run('UPDATE reset_tokens SET usado = 1 WHERE username = ?', [username]);

        // Nuevo token con expiración de 24 horas
        const token     = generarToken();
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
            .toISOString().replace('T', ' ').substring(0, 19);

        await db.run(
            'INSERT INTO reset_tokens (username, token, expires_at) VALUES (?, ?, ?)',
            [username, token, expiresAt]
        );

        if (email) {
            await db.run('UPDATE usuarios SET email = ? WHERE username = ?', [email, username]);
        }

        const destinatario = email || usuario.email;
        if (!destinatario) {
            return res.status(400).json({ ok: false, msg: "El usuario no tiene correo registrado" });
        }

        await enviarEnlaceReset({ destinatario, username, token });

        console.log(`🔗 Enlace de reset (24h) enviado a ${destinatario} para ${username}`);
        res.json({ ok: true, msg: "Enlace enviado correctamente" });

    } catch (e) {
        console.error("Error al reenviar clave:", e);
        res.status(500).json({ ok: false, msg: "Error: " + e.message });
    }
});

// ============================================================
// 8. VALIDAR TOKEN DE RESET
// ============================================================
app.get('/api/reset-token/:token', async (req, res) => {
    const { token } = req.params;
    try {
        const registro = await db.get(
            `SELECT * FROM reset_tokens
             WHERE token = ? AND usado = 0 AND expires_at > datetime('now')`,
            [token]
        );

        if (registro) {
            res.json({ ok: true, username: registro.username });
        } else {
            res.status(400).json({ ok: false, msg: "Token inválido o expirado" });
        }
    } catch (error) {
        res.status(500).json({ ok: false, msg: "Error al validar token" });
    }
});

// ============================================================
// 9. CAMBIAR CONTRASEÑA CON TOKEN (enlace de reset)
// ============================================================
app.post('/api/reset-password', async (req, res) => {
    const { token, newPassword } = req.body;
    try {
        const registro = await db.get(
            `SELECT * FROM reset_tokens
             WHERE token = ? AND usado = 0 AND expires_at > datetime('now')`,
            [token]
        );

        if (!registro) {
            return res.status(400).json({ ok: false, msg: "Token inválido o expirado" });
        }

        await db.run(
            'UPDATE usuarios SET password = ?, requiere_cambio = 0 WHERE username = ?',
            [newPassword, registro.username]
        );
        await db.run('UPDATE reset_tokens SET usado = 1 WHERE token = ?', [token]);

        res.json({ ok: true, msg: "Contraseña actualizada correctamente" });
    } catch (error) {
        res.status(500).json({ ok: false, msg: "Error al actualizar contraseña" });
    }
});

// ============================================================
// NUEVA FUNCIÓN: COMUNICACIÓN CON AS/400 (TERMINAL ISO 8583)
// ============================================================
const net = require('net'); // Asegúrate de hacer 'npm install ssh2'

// ... (Todo tu código anterior de rutas y APIs)

// ============================================================
// NUEVA FUNCIÓN: COMUNICACIÓN CON AS/400 (TERMINAL ISO 8583)
// ============================================================
const AS400_IP = '10.70.200.1';  // IP de la PANTALLA VERDE del banco
const AS400_PORT = 8602;         // Puerto donde escucha el programa TRACLITRM1

app.post('/api/ejecutar-trarput', (req, res) => {
    const { idtx, nodx, modx } = req.body;

    const client = new net.Socket();
    client.setTimeout(5000);

    client.connect(AS400_PORT, AS400_IP, () => {
        console.log(`✨ Conectado a AS/400 en puerto ${AS400_PORT}`);
        
        const objetoParaRPG = {
            id_transaccion: idtx,
            nodo: nodx,
            idx: modx
        };

        // Enviamos el JSON + salto de línea
        client.write(JSON.stringify(objetoParaRPG) + '\n');
        console.log("📤 JSON enviado al AS/400:", JSON.stringify(objetoParaRPG));
    });

    client.on('data', (data) => {
        try {
            const respuesta = data.toString().trim();
            const jsonResponse = JSON.parse(respuesta);
            client.destroy(); 
            res.json({ ok: true, ...jsonResponse });
        } catch (e) {
            client.destroy();
            res.json({ ok: true, rawData: data.toString().trim() });
        }
    });

    client.on('timeout', () => {
        client.destroy();
        res.status(408).json({ ok: false, msg: "AS/400 no respondió a tiempo" });
    });

    client.on('error', (err) => {
        console.error("❌ Error de Socket:", err.message);
        res.status(500).json({ ok: false, msg: "Conexión rechazada por AS/400" });
    });
});

// ... (Aquí mantén tus rutas de /api/login, /api/usuarios, etc.)

// ============================================================
// INICIO DEL SERVIDOR Y DETECCIÓN DE IP PARA TRAFI002
// ============================================================
let db;

inicializarTablas().then(database => {
    db = database;
    const SERVER_PORT = 3001;

    app.listen(SERVER_PORT, () => {
        console.log("===============================================");
        console.log(`🚀 Servidor Visual Admin en http://localhost:${SERVER_PORT}`);
        
        // SCRIPT PARA VER TU IP Y PONERLA EN EL AS400
        const networkInterfaces = os.networkInterfaces();
        console.log("📡 Direcciones IP para tu tabla TRAFI002:");
        
        Object.keys(networkInterfaces).forEach((interfaceName) => {
            networkInterfaces[interfaceName].forEach((iface) => {
                if (iface.family === 'IPv4' && !iface.internal) {
                    console.log(`   👉 Interfaz ${interfaceName}: ${iface.address}`);
                }
            });
        });
        console.log("===============================================");
    });
});