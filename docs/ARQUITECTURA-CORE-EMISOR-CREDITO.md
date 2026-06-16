# Core de Emisión y Crédito — Arquitectura del Sistema

> Sistema emisor de tarjetas + módulo de crédito, **agnóstico de plataforma**
> (se conecta con cualquier sistema: ISO 8583, AS/400, REST, apps, redes),
> con una **base de datos sólida** (contabilidad de doble partida) y diseñado
> para cubrir **todos los puntos de vista** (tarjetahabiente, operador,
> finanzas, integrador, riesgo, auditoría, DevOps).

---

## 1. Principios de diseño

1. **Ports & Adapters (Arquitectura Hexagonal)** → el núcleo de negocio NO sabe
   de dónde viene la petición ni a dónde escribe. Todo entra/sale por
   **adaptadores** intercambiables. Esto es lo que permite "conectar con
   cualquier plataforma" sin reescribir el core.
2. **Ledger de doble partida** → cada movimiento de dinero genera asientos
   balanceados (débito = crédito). Es la única forma de tener cuentas que
   "cuadren" siempre. Base de datos sólida = ledger inmutable + estados derivados.
3. **Idempotencia y trazabilidad** → toda operación tiene un `request_id`
   único; reintentos no duplican. Todo queda auditado.
4. **Separación de responsabilidades** → módulos de dominio independientes,
   comunicados por eventos.
5. **Seguridad desde el diseño** → tokenización del PAN, cifrado, RBAC,
   auditoría, mínimo privilegio (PCI-aware).

---

## 2. Arquitectura de alto nivel

```
┌─────────────────────────────────────────────────────────────────────┐
│                        ADAPTADORES DE ENTRADA                         │
│  ISO 8583   │  REST API   │  AS/400 WS  │  App/Portal  │  Webhooks    │
│ (autoriz.)  │ (terceros)  │  (Trafi)    │ (cardholder) │ (eventos)    │
└──────┬──────────┬─────────────┬─────────────┬──────────────┬──────────┘
       │          │             │             │              │
       ▼          ▼             ▼             ▼              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                  GATEWAY / CAPA DE APLICACIÓN (BFF)                    │
│         autenticación · idempotencia · validación · routing           │
└───────────────────────────────┬───────────────────────────────────────┘
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        NÚCLEO DE DOMINIO                               │
│  Clientes/KYC · Cuentas · Tarjetas · Autorización · CRÉDITO ·         │
│  Facturación · Pagos · Cobranza · Riesgo/Fraude · Catálogos           │
│                                                                       │
│                   ┌──────────────────────────┐                        │
│                   │  LEDGER (doble partida)   │  ← corazón contable    │
│                   └──────────────────────────┘                        │
└───────────────────────────────┬───────────────────────────────────────┘
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       ADAPTADORES DE SALIDA                           │
│  PostgreSQL  │  AS/400 (DB2/WS)  │  Redes (Visa/MC)  │  Buró crédito  │
│  PCI Vault/HSM │  Notificaciones (mail/SMS) │  Bus de eventos        │
└─────────────────────────────────────────────────────────────────────┘
```

**Por qué esto se "conecta con cualquier plataforma":** agregar un canal nuevo
(ej. otra red, otro core, una billetera) = escribir **un adaptador** que traduce
a/desde el modelo del núcleo. El core no cambia.

---

## 3. Módulos del dominio

| Módulo | Responsabilidad |
|--------|-----------------|
| **Clientes / KYC** | Datos del titular, identidad, verificación, estados |
| **Cuentas** | Cuentas financieras (débito/crédito), titularidad, estados |
| **Tarjetas** | Emisión de PAN (BIN+cuenta+Luhn), CVV, vencimiento, estados, físicas/virtuales |
| **Autorización** | Procesa ISO 8583/REST: valida PIN, saldo/línea, reglas → DE39 |
| **Ledger** | Asientos de doble partida, saldos, conciliación |
| **Crédito** ⭐ | Líneas, disponible, intereses, ciclos, scoring |
| **Facturación** | Cierre de ciclo, estado de cuenta, pago mínimo |
| **Pagos** | Registro y aplicación de pagos (capital/interés) |
| **Cobranza** | Mora, buckets 30/60/90, provisiones, reporte a buró |
| **Riesgo / Fraude** | Reglas de velocidad, geo, montos, scoring |
| **Catálogos** | BINes, productos de tarjeta, monedas, comisiones, tasas |
| **Auditoría** | Bitácora inmutable de toda acción |

---

## 4. Integración "con cualquier plataforma" (los puertos)

El núcleo define **puertos** (interfaces). Cada plataforma externa se enchufa
con un **adaptador** que implementa ese puerto.

### Puertos de ENTRADA (cómo te llaman)
- `AuthorizationPort` → autorizar una transacción (lo usa el adaptador ISO 8583 y el REST).
- `CardManagementPort` → crear/bloquear tarjetas.
- `PaymentPort` → registrar pagos.
- `QueryPort` → consultas (saldo, movimientos, estado de cuenta).

### Puertos de SALIDA (a quién llamas)
- `CoreBankingPort` → adaptador **AS/400** (vía web services Trafi / DB2).
- `LedgerPort` → adaptador **PostgreSQL**.
- `CardVaultPort` → adaptador **PCI Vault/HSM** (PAN cifrado).
- `NetworkPort` → adaptador **Visa/Mastercard**.
- `BureauPort` → adaptador **buró de crédito**.
- `NotificationPort` → mail/SMS/push.
- `EventBusPort` → publica eventos (`transaction.authorized`, `statement.generated`, etc.).

### Integración específica con tu AS/400
El `CoreBankingPort` se implementa con el **adaptador AS/400** que ya tienes
montado (relay `relay.tesh-desarrollo.com` → web services `Crud_Trafi*`,
`CRUD_PR01`, `MON_REST`). Si mañana cambias de core, solo reescribes este
adaptador; el módulo de crédito ni se entera.

---

## 5. Modelo de datos sólido (PostgreSQL)

Diseño relacional con **ledger de doble partida**. Resumen de las tablas clave
(DDL simplificado):

```sql
-- ───────────────── CLIENTES / CUENTAS / TARJETAS ─────────────────
CREATE TABLE clientes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  documento     TEXT NOT NULL,
  nombre        TEXT NOT NULL,
  email         TEXT,
  estado        TEXT NOT NULL DEFAULT 'ACTIVO',
  kyc_estado    TEXT NOT NULL DEFAULT 'PENDIENTE',
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE productos (              -- catálogo de productos de tarjeta
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre        TEXT NOT NULL,
  tipo          TEXT NOT NULL,        -- DEBITO | CREDITO
  moneda        TEXT NOT NULL DEFAULT 'USD',
  bin           TEXT NOT NULL,
  tasa_interes  NUMERIC(7,4),         -- anual, solo crédito
  dia_corte     INT,                  -- solo crédito
  dias_pago     INT                   -- gracia hasta fecha de pago
);

CREATE TABLE cuentas (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id    UUID NOT NULL REFERENCES clientes(id),
  producto_id   UUID NOT NULL REFERENCES productos(id),
  tipo          TEXT NOT NULL,        -- DEBITO | CREDITO
  moneda        TEXT NOT NULL DEFAULT 'USD',
  estado        TEXT NOT NULL DEFAULT 'ACTIVA',
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tarjetas (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cuenta_id     UUID NOT NULL REFERENCES cuentas(id),
  pan_token     TEXT NOT NULL,        -- NUNCA el PAN en claro: token al vault
  pan_ultimos4  TEXT NOT NULL,
  vencimiento   TEXT NOT NULL,        -- YYMM
  estado        TEXT NOT NULL DEFAULT 'ACTIVA',  -- ACTIVA|BLOQUEADA|CANCELADA
  es_virtual    BOOLEAN NOT NULL DEFAULT false,
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───────────────── LEDGER DE DOBLE PARTIDA ─────────────────
-- Cada transacción = 1 asiento con N líneas que SUMAN CERO.
CREATE TABLE asientos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id    TEXT UNIQUE NOT NULL,         -- idempotencia
  tipo          TEXT NOT NULL,                -- COMPRA|PAGO|INTERES|COMISION|REVERSO
  referencia    TEXT,
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE movimientos (            -- líneas del asiento
  id            BIGSERIAL PRIMARY KEY,
  asiento_id    UUID NOT NULL REFERENCES asientos(id),
  cuenta_id     UUID NOT NULL REFERENCES cuentas(id),
  monto         NUMERIC(18,2) NOT NULL,       -- + débito / - crédito
  moneda        TEXT NOT NULL DEFAULT 'USD',
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Invariante: SUM(monto) por asiento_id = 0  (se valida en transacción)

-- Saldo de una cuenta = SUM(movimientos.monto). Se puede materializar
-- en una tabla 'saldos' para lectura rápida, actualizada por trigger.

-- ───────────────── CRÉDITO ─────────────────
CREATE TABLE lineas_credito (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cuenta_id       UUID NOT NULL REFERENCES cuentas(id),
  limite          NUMERIC(18,2) NOT NULL,
  disponible      NUMERIC(18,2) NOT NULL,     -- limite - usado - autorizado
  tasa_interes    NUMERIC(7,4) NOT NULL,
  estado          TEXT NOT NULL DEFAULT 'ACTIVA',
  actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE autorizaciones (         -- holds antes del clearing
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tarjeta_id    UUID NOT NULL REFERENCES tarjetas(id),
  monto         NUMERIC(18,2) NOT NULL,
  stan          TEXT,                 -- DE11 ISO 8583
  rrn           TEXT,                 -- DE37
  de39          TEXT,                 -- código respuesta
  estado        TEXT NOT NULL,        -- APROBADA|RECHAZADA|REVERSADA|LIQUIDADA
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ciclos_facturacion (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cuenta_id     UUID NOT NULL REFERENCES cuentas(id),
  fecha_corte   DATE NOT NULL,
  fecha_pago    DATE NOT NULL,
  saldo_anterior NUMERIC(18,2) NOT NULL DEFAULT 0,
  saldo_nuevo   NUMERIC(18,2) NOT NULL DEFAULT 0,
  pago_minimo   NUMERIC(18,2) NOT NULL DEFAULT 0,
  intereses     NUMERIC(18,2) NOT NULL DEFAULT 0,
  estado        TEXT NOT NULL DEFAULT 'ABIERTO'  -- ABIERTO|CERRADO|PAGADO|MORA
);

CREATE TABLE pagos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cuenta_id     UUID NOT NULL REFERENCES cuentas(id),
  monto         NUMERIC(18,2) NOT NULL,
  canal         TEXT,                 -- TRANSFERENCIA|EFECTIVO|etc
  asiento_id    UUID REFERENCES asientos(id),
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───────────────── SEGURIDAD / AUDITORÍA ─────────────────
CREATE TABLE usuarios (               -- operadores del back-office
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT UNIQUE NOT NULL,
  rol           TEXT NOT NULL,        -- ADMIN|OPERADOR|FINANZAS|AUDITOR|...
  estado        TEXT NOT NULL DEFAULT 'ACTIVO'
);

CREATE TABLE auditoria (              -- bitácora inmutable
  id            BIGSERIAL PRIMARY KEY,
  usuario_id    UUID,
  accion        TEXT NOT NULL,
  entidad       TEXT,
  entidad_id    TEXT,
  detalle       JSONB,
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Reglas de oro de la base de datos:**
- El **PAN nunca** se guarda en claro → solo `pan_token` (referencia al vault) y `pan_ultimos4`.
- El saldo **se deriva del ledger**, no se "edita" a mano.
- Toda escritura de dinero pasa por un **asiento balanceado** dentro de una transacción SQL.
- `request_id` único garantiza **idempotencia** (reintentos seguros).

---

## 6. Diseño de API (REST + eventos)

```
POST /v1/clientes
POST /v1/cuentas
POST /v1/tarjetas                 (emitir)
POST /v1/tarjetas/{id}/bloquear
POST /v1/autorizaciones           (autorizar — también vía ISO 8583)
POST /v1/pagos
GET  /v1/cuentas/{id}/saldo
GET  /v1/cuentas/{id}/movimientos
GET  /v1/cuentas/{id}/estado-cuenta?ciclo=YYYY-MM
```

- **Idempotencia:** header `Idempotency-Key` en toda escritura.
- **Webhooks:** el sistema notifica eventos a plataformas externas
  (`transaction.authorized`, `payment.received`, `statement.generated`,
  `card.blocked`). Así "cualquier plataforma" se entera sin hacer polling.
- **Autenticación:** API Key / OAuth2 por integrador + RBAC.

---

## 7. Todos los puntos de vista (vistas por stakeholder)

| Punto de vista | Qué ve / qué necesita |
|----------------|-----------------------|
| **Tarjetahabiente** | App/portal: saldo, movimientos, estado de cuenta, pagar, bloquear, tarjeta virtual |
| **Operador / Back-office** | Alta de clientes/tarjetas, ajustes, bloqueos, búsqueda (estilo tu `visual-admin`) |
| **Finanzas / Contabilidad** | Cuadre del ledger, conciliación con red y banco, provisiones, reportes |
| **Riesgo / Crédito** | Scoring, asignación de líneas, mora, buckets, provisiones |
| **Integrador / Dev** | API REST, webhooks, sandbox (tu **simulador ISO 8583** sirve aquí 🎯), docs |
| **Auditoría / Compliance** | Bitácora inmutable, trazabilidad, controles PCI/AML |
| **DevOps / SRE** | Salud de servicios, monitor de puertos (ya lo tienes), logs, métricas, despliegue |

---

## 8. Seguridad y cumplimiento

- **PCI DSS:** PAN cifrado/tokenizado, HSM para llaves (ya manejas `Trafi800`),
  segmentación, mínimo acceso.
- **Cifrado:** en tránsito (TLS) y en reposo (DB cifrada).
- **RBAC:** roles por módulo, principio de mínimo privilegio.
- **AML/KYC:** verificación de identidad, listas, monitoreo de transacciones.
- **Auditoría inmutable:** quién hizo qué y cuándo.

---

## 9. Stack tecnológico propuesto (alineado a lo que ya usas)

| Capa | Tecnología |
|------|------------|
| Lenguaje | **Node.js** (igual que tus apps) |
| Base de datos | **PostgreSQL / Neon** (ya lo usas) |
| ISO 8583 | Tu librería actual (`lib/iso8583.js`) + simulador |
| Core legado | **AS/400** vía web services (relay actual) |
| API | Express + OpenAPI |
| Eventos | Cola (Redis/RabbitMQ) o tabla `outbox` + webhooks |
| Front | HTML/JS (como `visual-admin`) o framework SPA |
| Despliegue | Render (web) + tu servidor `tesh-desarrollo.com` (TCP/core) |

---

## 10. Despliegue (multi-plataforma)

```
┌────────────────────┐     ┌──────────────────────────┐     ┌──────────────┐
│  Render (web/API)  │────▶│ relay.tesh-desarrollo.com │────▶│   AS/400     │
│  - Back-office     │     │ (adaptador core / TCP)    │     │   (Trafi)    │
│  - API REST        │     └──────────────────────────┘     └──────────────┘
│  - Portal cliente  │
└─────────┬──────────┘
          │ ISO 8583 / REST
          ▼
┌────────────────────┐
│ Simulador 8583     │  (sandbox para certificar/probar autorización)
│ tesh-desarrollo.com│
└────────────────────┘
```

---

## 11. Roadmap por fases

1. **Fase 0 — Cimientos:** modelo de datos + ledger de doble partida + auditoría.
2. **Fase 1 — Emisión:** clientes, cuentas, tarjetas (PAN/CVV), back-office.
3. **Fase 2 — Autorización:** motor que recibe ISO 8583, valida y responde DE39
   (probado con tu simulador). Adaptador AS/400.
4. **Fase 3 — Crédito:** líneas, autorizaciones (holds), intereses.
5. **Fase 4 — Facturación y pagos:** ciclos, estados de cuenta, pagos, mora.
6. **Fase 5 — Portal cliente + webhooks + API pública** (conectar terceros).
7. **Fase 6 — Riesgo/fraude + reportería + certificación de red.**

---

## 12. Por qué esta estructura cumple lo que pediste

- ✅ **Se conecta con cualquier plataforma** → arquitectura de puertos y
  adaptadores; agregar un sistema nuevo = un adaptador, sin tocar el core.
- ✅ **Base de datos sólida** → ledger de doble partida, saldos derivados,
  idempotencia, auditoría inmutable.
- ✅ **Todos los puntos de vista** → vistas separadas para titular, operador,
  finanzas, riesgo, integrador, auditoría y DevOps.
- ✅ **Aprovecha lo que ya tienes** → AS/400, ISO 8583, simulador, Postgres,
  Render y tu dominio `tesh-desarrollo.com`.
```
