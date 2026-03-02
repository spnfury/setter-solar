# 🌞 Setter Solar — Dashboard de Llamadas IA

Dashboard de setting automatizado de leads de **placas solares** basado en Vapi + NocoDB.
Fork del sistema general de llamadas outbound, adaptado específicamente para el sector fotovoltaico.

## Stack

- **Frontend**: HTML + Vanilla JS + CSS (dark mode, glassmorphism)
- **IA Voice**: [Vapi](https://vapi.ai) — llamadas outbound con transcripción
- **Base de datos**: [NocoDB](https://nocodb.com) — tablas de leads, logs y citas
- **Deploy**: Vercel

---

## Setup

```bash
cp config.example.js config.js
# Rellena tus API keys en config.js
npm install
npm run dev
```

---

## ✅ Lo que se reutiliza del proyecto base

| Módulo | Archivo | Estado |
|---|---|---|
| Dashboard general + KPIs | `index.html` | ✅ Reutilizable |
| Estilos dark mode / glassmorphism | `style.css` | ✅ Reutilizable |
| Lógica de llamadas Vapi | `main.js` | ✅ Reutilizable (adaptar prompt) |
| Monitor en tiempo real | `main.js` → realtime | ✅ Reutilizable |
| Programador bulk de llamadas | `main.js` → scheduler | ✅ Reutilizable |
| Informes diarios con IA | `daily_analysis.mjs` | ✅ Reutilizable |
| Import CSV de leads | `main.js` → leads tab | ✅ Reutilizable |
| Retry / Rellamar con contexto | `retry_call.mjs` | ✅ Reutilizable |
| Launch manual de llamada puntual | `launch_now.mjs` | ✅ Reutilizable |

---

## 🔧 Lo que hay que cambiar / adaptar

### 1. Asistente Vapi (CRÍTICO)
- Crear un **nuevo asistente** en Vapi específico para solar
- El `systemPrompt` debe mencionar: placas solares, ahorro energético, instalación, subvenciones, etc.
- Actualizar los IDs de asistente en `config.js` (`VAPI_ASSISTANT_ID`)

### 2. NocoDB — Tablas
- Crear nuevas tablas (o schema) para el proyecto solar:
  - **Leads Solares**: nombre, teléfono, email, dirección, tipo de propiedad, consumo mensual estimado, interés declarado
  - **Logs de Llamadas**: misma estructura que el proyecto base
  - **Citas Confirmadas**: nombre, teléfono, email, fecha/hora visita técnica
- Los campos a capturar en la conversación son distintos: no es "sector empresa" sino "tipo de propiedad" (vivienda, negocio, comunidad)

### 3. Campos del dashboard (moderado)
- Cambiar columna **"Empresa"** → **"Nombre"** (leads B2C, no B2B)
- Cambiar columna **"Sector"** → **"Tipo inmueble"** (vivienda / negocio / comunidad)
- Añadir campo **"Consumo estimado"** y **"¿Tiene tejado?"**
- Sección de datos confirmados: en lugar de nombre+email+teléfono → añadir **fecha de visita técnica**

### 4. Prompt del agente IA
- Objetivo: concertar una **visita técnica gratuita** (no una reunión B2B)
- Mencionar: ahorro en factura, subvenciones disponibles, sin coste de estudio
- Capturar: tipo de inmueble, consumo aproximado, disponibilidad para visita
- Dejar de mencionar: "seguros", "protección de empresa", conceptos B2B

### 5. Textos y branding del UI
- Título: **"Setter Solar Dashboard"**
- Logo: cambiar `logo.png` por logo solar
- Asistentes en los selects: cambiar "Violeta / Marcos" por el nombre del nuevo agente solar
- Versión: resetear a `v0.1.0`

### 6. Scripts de utilidad (menor)
- `bulk_call_all.mjs`: actualizar `assistantId` al nuevo agente solar
- `preflight_check.mjs`: ajustar validaciones si los campos del lead cambian
- `schedule_tomorrow.mjs`: puede usarse tal cual

---

## 📋 Prioridad de cambios

```
FASE 1 — Funcional (1-2 días)
  [ ] Crear asistente Vapi para solar
  [ ] Crear tablas NocoDB con campos solares
  [ ] Actualizar config.js con nuevos IDs
  [ ] Cambiar campos "Empresa" → "Nombre" y "Sector" → "Tipo inmueble"

FASE 2 — Optimización (3-5 días)
  [ ] Añadir campo "Fecha visita técnica" en datos confirmados
  [ ] Ajustar score de evaluación para criterios solares
  [ ] Branding (logo, título, colores)

FASE 3 — Avanzado
  [ ] Informe diario adaptado a KPIs solares (visitas agendadas, tasa de conversión)
  [ ] Segmentación por zona geográfica
```
