const express = require('express');
const cors    = require('cors');
const path    = require('path');
const crypto  = require('crypto');
const nodemailer = require('nodemailer');
const { inicializarTablas } = require('./database');
const os = require('os');
const net = require('net'); 

const app = express();

app.use(cors());
app.use(express.json());

// --- MODIFICACIÓN 1: RUTA DE ARCHIVOS ESTÁTICOS ---
// Usamos path.join(__dirname, 'public') para que encuentre la carpeta sin importar el sistema
app.use(express.static(path.join(__dirname, 'public')));

// --- MODIFICACIÓN 2: RUTA RAÍZ (SOLUCIONA EL "NOT FOUND") ---
// Cuando alguien entre a https://tu-app.onrender.com/ se cargará el login automáticamente
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
const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';

// ... (Tus funciones enviarClaveEmail, enviarEnlaceReset y generarToken se mantienen igual)

// ... (Tus rutas /api/login, /api/update-password, /api/usuarios, etc. se mantienen igual)

// ============================================================
// COMUNICACIÓN CON AS/400 (Mantenemos tu lógica igual)
// ============================================================
const AS400_IP = '10.70.200.1'; 
const AS400_PORT = 8602; 

app.post('/api/ejecutar-trarput', (req, res) => {
    const { idtx, nodx, modx } = req.body;
    const client = new net.Socket();
    client.setTimeout(5000);

    client.connect(AS400_PORT, AS400_IP, () => {
        const objetoParaRPG = { id_transaccion: idtx, nodo: nodx, idx: modx };
        client.write(JSON.stringify(objetoParaRPG) + '\n');
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
        res.status(500).json({ ok: false, msg: "Conexión rechazada por AS/400" });
    });
});

// ============================================================
// INICIO DEL SERVIDOR (MODIFICACIÓN 3: PUERTO DINÁMICO)
// ============================================================
let db;

inicializarTablas().then(database => {
    db = database;
    // IMPORTANTE: process.env.PORT es lo que usa Render
    const SERVER_PORT = process.env.PORT || 3001;

    app.listen(SERVER_PORT, () => {
        console.log("===============================================");
        console.log(`🚀 Servidor Visual Admin activo en puerto: ${SERVER_PORT}`);
        
        const networkInterfaces = os.networkInterfaces();
        Object.keys(networkInterfaces).forEach((interfaceName) => {
            networkInterfaces[interfaceName].forEach((iface) => {
                if (iface.family === 'IPv4' && !iface.internal) {
                    console.log(`   👉 IP detectada: ${iface.address}`);
                }
            });
        });
        console.log("===============================================");
    });
});