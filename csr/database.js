const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');

async function inicializarTablas() {
    const rootDir = path.resolve(__dirname, '..');
    const dbPath  = path.join(rootDir, 'travisor.db');

    console.log("📍 Base de datos en:", dbPath);

    const db = await open({
        filename: dbPath,
        driver:   sqlite3.Database
    });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS usuarios (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre           TEXT,
            username         TEXT UNIQUE NOT NULL,
            email            TEXT,
            password         TEXT NOT NULL,
            rol              TEXT NOT NULL DEFAULT 'Operador',
            nodos            TEXT DEFAULT '[]',
            estado           TEXT NOT NULL DEFAULT 'ACTIVO',
            requiere_cambio  INTEGER NOT NULL DEFAULT 1,
            created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    const columnas = ['nombre', 'email', 'nodos', 'estado'];
    for (const col of columnas) {
        try {
            await db.run(`ALTER TABLE usuarios ADD COLUMN ${col} TEXT`);
            console.log(`✅ Columna '${col}' agregada`);
        } catch { /* ya existe */ }
    }

    // Tabla de tokens para reseteo por enlace
    await db.exec(`
        CREATE TABLE IF NOT EXISTS reset_tokens (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            username   TEXT NOT NULL,
            token      TEXT UNIQUE NOT NULL,
            expires_at DATETIME NOT NULL,
            usado      INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await db.run(`
        INSERT OR IGNORE INTO usuarios (nombre, username, email, password, rol, nodos, estado, requiere_cambio)
        VALUES ('Administrador', 'admin', 'admin@empresa.com', 'admin123', 'ADMIN', '[]', 'ACTIVO', 1)
    `);

    console.log("✅ Base de datos lista.");
    return db;
}

module.exports = { inicializarTablas };