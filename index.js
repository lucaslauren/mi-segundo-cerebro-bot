/**
 * SEGUNDO CEREBRO BOT v6.0
 * Secretario personal de Lucas Hernán Laurenzano
 *
 * Arquitectura: Tool Use nativo de Claude
 * Claude decide qué herramientas usar en cada conversación.
 * No hay intenciones predefinidas ni JSON estructurado.
 */

const express = require('express');
const bodyParser = require('body-parser');
const Anthropic = require('@anthropic-ai/sdk');
const { Client } = require('@notionhq/client');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();
app.use(bodyParser.json({ limit: '10mb' }));

// ─── Clientes ────────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
const notion = new Client({ auth: process.env.NOTION_TOKEN });

const NOTION_DB_ID = process.env.NOTION_DATABASE_ID;
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'lucas@dlaurenzano.com';
const NOTION_HISTORIAL_ID = '3626046f0fee80188b21c9964d5610f7';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// ─── Memoria de sesión ────────────────────────────────────────────────────────
const memoriaSession = new Map();
const MAX_MENSAJES = 20;

function agregarMensaje(chatId, role, content) {
  if (!memoriaSession.has(chatId)) memoriaSession.set(chatId, []);
  const h = memoriaSession.get(chatId);
  h.push({ role, content });
  if (h.length > MAX_MENSAJES) h.shift();
}

function obtenerHistorial(chatId) {
  return memoriaSession.get(chatId) || [];
}

// ─── Google Auth ──────────────────────────────────────────────────────────────
function getGoogleAuth(scopes) {
  try {
    const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
    if (!creds.client_email) return null;
    if (creds.private_key) creds.private_key = creds.private_key.replace(/\\n/g, '\n');
    return new google.auth.JWT(
      creds.client_email,
      null,
      creds.private_key,
      scopes,
      'lucas@dlaurenzano.com'  // Impersonar a Lucas
    );
  } catch (e) {
    console.error('⚠️ Google Auth error:', e.message);
    return null;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fechaHoy() {
  return new Date().toLocaleDateString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}

function fechaISO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
}

function sumarHora(h, n) {
  const [hh, mm] = h.split(':').map(Number);
  const d = new Date(); d.setHours(hh + n, mm, 0);
  return d.toTimeString().substring(0, 5);
}

// Argentina es siempre UTC-3, sin DST
function getBuenosAiresDateRange(periodo) {
  const TZ = 'America/Argentina/Buenos_Aires';
  const OFFSET = '-03:00';
  const hoyStr = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  const [y, m, d] = hoyStr.split('-').map(Number);

  if (periodo === 'hoy') {
    return { timeMin: `${hoyStr}T00:00:00${OFFSET}`, timeMax: `${hoyStr}T23:59:59${OFFSET}` };
  }
  if (periodo === 'mañana') {
    const manStr = new Date(Date.UTC(y, m - 1, d + 1)).toLocaleDateString('en-CA', { timeZone: TZ });
    return { timeMin: `${manStr}T00:00:00${OFFSET}`, timeMax: `${manStr}T23:59:59${OFFSET}` };
  }
  // semana
  const en7Str = new Date(Date.UTC(y, m - 1, d + 7)).toLocaleDateString('en-CA', { timeZone: TZ });
  return { timeMin: `${hoyStr}T00:00:00${OFFSET}`, timeMax: `${en7Str}T23:59:59${OFFSET}` };
}

function mapTarea(page) {
  return {
    id: page.id,
    titulo: page.properties['Siguiente acción']?.title?.[0]?.text?.content || '',
    contexto: page.properties['Contexto']?.select?.name || null,
    dia_accion: page.properties['Dia acción']?.date?.start || null,
    fecha_limite: page.properties['Fecha límite']?.date?.start || null,
    me_gustaria_hoy: page.properties['Me gustaría hoy']?.checkbox || false,
    en_espera: page.properties['En espera']?.rich_text?.[0]?.text?.content || null
  };
}

// ─── System Prompt ────────────────────────────────────────────────────────────
function buildSystemPrompt() {
  return `Sos el secretario personal IA de Lucas Hernán Laurenzano.

FECHA Y HORA ACTUAL: ${fechaHoy()}

QUIÉN ES LUCAS:
- CEO de DLP (Daniel Laurenzano Propiedades) - inmobiliaria
- Co-fundador de Smart Developments SRL - desarrolladora inmobiliaria
- Socio en Tuluka/Tuluvoto - gimnasio en Villa Devoto
- Vive en Buenos Aires con su pareja Julia y su hijo Vito
- Entrena lunes a viernes

TU ROL:
Sos su cerebro externo y secretario personal. Lucas NO tiene que mirar Notion, Calendar ni Drive — vos le decís todo y ejecutás todo. Hablás de manera directa, concisa y útil. No sos formal ni rígido. Usás emojis con moderación.

SISTEMA GTD EN NOTION:
- Toda tarea tiene: título (acción física), contexto, proyecto, fecha, prioridad
- Contextos (T = Trabajo, sin T = Personal):
  ROCA/T ROCA, Ordenador/T Ordenador, < 5 min/T < 5 min,
  Tarea manual casa, Energía baja, algún día/ a lo mejor/T algún día/ a lo mejor,
  Tarea fuera de casa, Leer/Revisar, T Leer/ Revisar,
  T Tarea manual oficina, T Tarea fuera oficina

PROYECTOS ACTIVOS:
- SDVL | N3302 (Smart Developments - Bahía Blanca)
- LAURENGROUP | Contabilidad
- DLP | Avances CUPULA
- SMART | CUPULA + MARIAN

REGLAS IMPORTANTES:
1. Reescribí las tareas como acciones físicas concretas (verbo + objeto)
2. Inferí el contexto y proyecto más probable según el contenido
3. Si Lucas dice "ya hice X", buscá esa tarea en Notion y marcala como hecha
4. Si no encontrás la tarea exacta, buscá la más similar semánticamente
5. Podés ejecutar múltiples herramientas en un solo mensaje
6. Respondé siempre en español argentino, de manera directa y útil
7. Cuando uses herramientas, esperá el resultado antes de responder
8. CONTEXTOS CON T (ej: T Ordenador, T ROCA, T < 5 min) = TRABAJO. Sin T = PERSONAL.
   Cuando Lucas pregunta por tareas "del trabajo" → filtro "trabajo"
   Cuando pregunta por tareas "personales" → filtro "personal"
   Cuando pregunta en general → filtro "todas"
9. COLORES DE CALENDARIO al crear eventos:
   - Reuniones de trabajo, DLP, Smart, Tuluka → colorId "9" (Laboral, azul)
   - Personal, familia, Vito, Julia, amigos → colorId "5" (Personal, amarillo)
   - Gym, deporte, cursos, facultad, libros → colorId "4" (Desarrollo personal, rosa)
   - Viajes, traslados, autos → colorId "11" (Transporte, rojo)
   - Reuniones solo vos sin equipo → colorId "9" (Laboral solo yo, azul)`;
}

// ─── Definición de herramientas ───────────────────────────────────────────────
const TOOLS = [
  {
    name: 'crear_tarea_notion',
    description: 'Crea una nueva tarea en Notion con clasificación GTD automática',
    input_schema: {
      type: 'object',
      properties: {
        titulo: { type: 'string', description: 'Acción física concreta: verbo + objeto' },
        contexto: { type: 'string', description: 'Contexto GTD exacto de la lista disponible' },
        proyecto: { type: 'string', description: 'Nombre exacto del proyecto o null' },
        dia_accion: { type: 'string', description: 'Fecha YYYY-MM-DD o null' },
        fecha_limite: { type: 'string', description: 'Fecha límite YYYY-MM-DD o null' },
        me_gustaria_hoy: { type: 'boolean', description: 'true si es para hacer hoy' },
        en_espera: { type: 'string', description: 'Formato: "Nombre re: tema" o null' }
      },
      required: ['titulo']
    }
  },
  {
    name: 'buscar_y_marcar_hecha',
    description: 'Busca una tarea en Notion y la marca como hecha. Puede marcar múltiples tareas.',
    input_schema: {
      type: 'object',
      properties: {
        busquedas: {
          type: 'array',
          items: { type: 'string' },
          description: 'Lista de palabras clave para buscar cada tarea. Incluí nombres propios y palabras específicas.'
        }
      },
      required: ['busquedas']
    }
  },
  {
    name: 'consultar_tareas',
    description: 'Consulta tareas pendientes en Notion',
    input_schema: {
      type: 'object',
      properties: {
        filtro: {
          type: 'string',
          enum: ['hoy', 'mañana', 'semana', 'todas', 'en_espera', 'proyecto', 'trabajo', 'personal'],
          description: 'Qué tareas traer. "trabajo" = solo contextos con T. "personal" = solo contextos sin T'
        },
        proyecto: { type: 'string', description: 'Nombre del proyecto si filtro es "proyecto"' }
      },
      required: ['filtro']
    }
  },
  {
    name: 'editar_tarea',
    description: 'Modifica una tarea existente en Notion',
    input_schema: {
      type: 'object',
      properties: {
        busqueda: { type: 'string', description: 'Palabras clave para encontrar la tarea' },
        cambios: {
          type: 'object',
          properties: {
            titulo: { type: 'string' },
            contexto: { type: 'string' },
            dia_accion: { type: 'string' },
            fecha_limite: { type: 'string' },
            me_gustaria_hoy: { type: 'boolean' }
          }
        }
      },
      required: ['busqueda', 'cambios']
    }
  },
  {
    name: 'crear_evento_calendario',
    description: 'Crea un evento en Google Calendar de Lucas',
    input_schema: {
      type: 'object',
      properties: {
        titulo: { type: 'string', description: 'Nombre del evento' },
        fecha: { type: 'string', description: 'Fecha YYYY-MM-DD' },
        hora_inicio: { type: 'string', description: 'HH:MM o null si es todo el día' },
        hora_fin: { type: 'string', description: 'HH:MM o null' },
        descripcion: { type: 'string', description: 'Descripción opcional' },
        todo_el_dia: { type: 'boolean', description: 'true si es evento de todo el día' },
        colorId: { type: 'string', description: 'Color: 9=Laboral (azul), 5=Personal (amarillo), 4=Desarrollo personal (rosa), 11=Transporte (rojo)' }
      },
      required: ['titulo', 'fecha']
    }
  },
  {
    name: 'consultar_calendario',
    description: 'Consulta eventos del calendario de Lucas',
    input_schema: {
      type: 'object',
      properties: {
        periodo: {
          type: 'string',
          enum: ['hoy', 'mañana', 'semana'],
          description: 'Período a consultar'
        }
      },
      required: ['periodo']
    }
  },
  {
    name: 'buscar_en_drive',
    description: 'Busca archivos en Google Drive de Lucas y devuelve los links',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Qué buscar en Drive (nombre del archivo, tema, etc.)' },
        tipo: {
          type: 'string',
          enum: ['documento', 'hoja de calculo', 'presentacion', 'pdf', 'cualquiera'],
          description: 'Tipo de archivo a buscar'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'plan_del_dia',
    description: 'Genera el plan del día con tareas y eventos del calendario',
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    }
  }
];

// ─── Implementación de herramientas ───────────────────────────────────────────

async function tool_crear_tarea_notion(input) {
  try {
    const properties = {
      'Siguiente acción': { title: [{ text: { content: input.titulo } }] },
      'Hecho': { checkbox: false }
    };
    if (input.contexto) properties['Contexto'] = { select: { name: input.contexto } };
    if (input.dia_accion) properties['Dia acción'] = { date: { start: input.dia_accion } };
    if (input.fecha_limite) properties['Fecha límite'] = { date: { start: input.fecha_limite } };
    if (input.me_gustaria_hoy) properties['Me gustaría hoy'] = { checkbox: true };
    if (input.en_espera) properties['En espera'] = { rich_text: [{ text: { content: input.en_espera } }] };

    const page = await notion.pages.create({ parent: { database_id: NOTION_DB_ID }, properties });
    console.log('✅ Tarea creada:', input.titulo);

    // Guardar en historial
    await guardarHistorial(`Creó tarea: "${input.titulo}"`, input.contexto);

    return { ok: true, titulo: input.titulo, contexto: input.contexto || 'sin contexto', id: page.id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function tool_buscar_y_marcar_hecha(input) {
  const stopWords = ['hablar', 'llamar', 'reunir', 'contactar', 'registrar', 'hacer', 'con', 'por', 'para', 'sobre', 'hice', 'hable', 'llame', 'arregle', 'termine'];
  const resultados = [];

  for (const busqueda of input.busquedas) {
    try {
      const palabras = busqueda.split(' ').filter(p => p.length > 2);
      const especificas = palabras.filter(p => !stopWords.includes(p.toLowerCase()));
      const todasLasPalabras = [...new Set([...especificas, ...palabras])];

      let tareaEncontrada = null;

      for (const palabra of todasLasPalabras) {
        const resp = await notion.databases.query({
          database_id: NOTION_DB_ID,
          filter: {
            and: [
              { property: 'Hecho', checkbox: { equals: false } },
              { property: 'Siguiente acción', title: { contains: palabra } }
            ]
          },
          page_size: 5
        });
        if (resp.results.length > 0) {
          tareaEncontrada = resp.results[0];
          break;
        }
      }

      if (tareaEncontrada) {
        const titulo = tareaEncontrada.properties['Siguiente acción']?.title?.[0]?.text?.content || '';
        await notion.pages.update({
          page_id: tareaEncontrada.id,
          properties: { 'Hecho': { checkbox: true } }
        });
        await guardarHistorial(`Marcó como hecha: "${titulo}"`, null);
        resultados.push({ busqueda, encontrada: titulo, ok: true });
        console.log('✅ Marcada hecha:', titulo);
      } else {
        resultados.push({ busqueda, ok: false, mensaje: 'No encontrada' });
      }
    } catch (e) {
      resultados.push({ busqueda, ok: false, error: e.message });
    }
  }

  return resultados;
}

async function tool_consultar_tareas(input) {
  try {
    const hoy = fechaISO();
    let tareas = [];

    if (input.filtro === 'hoy') {
      const resp = await notion.databases.query({
        database_id: NOTION_DB_ID,
        filter: {
          and: [
            { property: 'Hecho', checkbox: { equals: false } },
            { or: [
              { property: 'Me gustaría hoy', checkbox: { equals: true } },
              { property: 'Dia acción', date: { equals: hoy } }
            ]}
          ]
        }
      });
      tareas = resp.results.map(mapTarea);
    } else if (input.filtro === 'mañana') {
      const d = new Date(); d.setDate(d.getDate() + 1);
      const manana = d.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
      const resp = await notion.databases.query({
        database_id: NOTION_DB_ID,
        filter: {
          and: [
            { property: 'Hecho', checkbox: { equals: false } },
            { property: 'Dia acción', date: { equals: manana } }
          ]
        }
      });
      tareas = resp.results.map(mapTarea);
    } else if (input.filtro === 'semana') {
      const en7 = new Date(); en7.setDate(en7.getDate() + 7);
      const en7ISO = en7.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
      const resp = await notion.databases.query({
        database_id: NOTION_DB_ID,
        filter: {
          and: [
            { property: 'Hecho', checkbox: { equals: false } },
            { property: 'Dia acción', date: { on_or_after: hoy } },
            { property: 'Dia acción', date: { on_or_before: en7ISO } }
          ]
        },
        sorts: [{ property: 'Dia acción', direction: 'ascending' }],
        page_size: 50
      });
      tareas = resp.results.map(mapTarea);
    } else if (input.filtro === 'en_espera') {
      const resp = await notion.databases.query({
        database_id: NOTION_DB_ID,
        filter: {
          and: [
            { property: 'Hecho', checkbox: { equals: false } },
            { property: 'En espera', rich_text: { is_not_empty: true } }
          ]
        }
      });
      tareas = resp.results.map(mapTarea);
    } else if (input.filtro === 'trabajo') {
      const contextosT = ['T ROCA', 'T Ordenador', 'T < 5 min', 'T algún día/ a lo mejor', 'T Leer/ Revisar', 'T Tarea manual oficina', 'T Tarea fuera oficina'];
      const resp = await notion.databases.query({
        database_id: NOTION_DB_ID,
        filter: {
          and: [
            { property: 'Hecho', checkbox: { equals: false } },
            { or: contextosT.map(c => ({ property: 'Contexto', select: { equals: c } })) }
          ]
        },
        sorts: [{ property: 'Dia acción', direction: 'ascending' }],
        page_size: 50
      });
      tareas = resp.results.map(mapTarea);
    } else if (input.filtro === 'personal') {
      const contextosPersonales = ['ROCA', 'Ordenador', '< 5 min', 'algún día/ a lo mejor', 'Tarea manual casa', 'Energía baja', 'Tarea fuera de casa', 'Leer/Revisar'];
      const resp = await notion.databases.query({
        database_id: NOTION_DB_ID,
        filter: {
          and: [
            { property: 'Hecho', checkbox: { equals: false } },
            { or: [
              { property: 'Contexto', select: { is_empty: true } },
              ...contextosPersonales.map(c => ({ property: 'Contexto', select: { equals: c } }))
            ]}
          ]
        },
        sorts: [{ property: 'Dia acción', direction: 'ascending' }],
        page_size: 50
      });
      tareas = resp.results.map(mapTarea);
    } else {
      // todas — contextos personales y de trabajo
      const todosContextos = [
        'ROCA', 'T ROCA', 'Ordenador', 'T Ordenador', '< 5 min', 'T < 5 min',
        'Tarea manual casa', 'Energía baja', 'algún día/ a lo mejor', 'T algún día/ a lo mejor',
        'Tarea fuera de casa', 'Leer/Revisar', 'T Leer/ Revisar',
        'T Tarea manual oficina', 'T Tarea fuera oficina'
      ];
      const resp2 = await notion.databases.query({
        database_id: NOTION_DB_ID,
        filter: {
          and: [
            { property: 'Hecho', checkbox: { equals: false } },
            { or: [
              { property: 'Contexto', select: { is_empty: true } },
              ...todosContextos.map(c => ({ property: 'Contexto', select: { equals: c } }))
            ]}
          ]
        },
        sorts: [{ property: 'Dia acción', direction: 'ascending' }],
        page_size: 50
      });
      tareas = resp2.results.map(mapTarea);
    }

    return { filtro: input.filtro, cantidad: tareas.length, tareas };
  } catch (e) {
    return { error: e.message };
  }
}

async function tool_editar_tarea(input) {
  try {
    const stopWords = ['tarea', 'hacer', 'con', 'por', 'para', 'sobre'];
    const palabras = input.busqueda.split(' ').filter(p => p.length > 2 && !stopWords.includes(p.toLowerCase()));

    let tareaEncontrada = null;
    for (const palabra of palabras) {
      const resp = await notion.databases.query({
        database_id: NOTION_DB_ID,
        filter: {
          and: [
            { property: 'Hecho', checkbox: { equals: false } },
            { property: 'Siguiente acción', title: { contains: palabra } }
          ]
        },
        page_size: 5
      });
      if (resp.results.length > 0) { tareaEncontrada = resp.results[0]; break; }
    }

    if (!tareaEncontrada) return { ok: false, mensaje: `No encontré tarea con "${input.busqueda}"` };

    const titulo = tareaEncontrada.properties['Siguiente acción']?.title?.[0]?.text?.content || '';
    const properties = {};
    if (input.cambios.titulo) properties['Siguiente acción'] = { title: [{ text: { content: input.cambios.titulo } }] };
    if (input.cambios.contexto) properties['Contexto'] = { select: { name: input.cambios.contexto } };
    if (input.cambios.dia_accion) properties['Dia acción'] = { date: { start: input.cambios.dia_accion } };
    if (input.cambios.fecha_limite) properties['Fecha límite'] = { date: { start: input.cambios.fecha_limite } };
    if (input.cambios.me_gustaria_hoy !== undefined) properties['Me gustaría hoy'] = { checkbox: input.cambios.me_gustaria_hoy };

    await notion.pages.update({ page_id: tareaEncontrada.id, properties });
    return { ok: true, tarea: titulo, cambios: input.cambios };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function tool_crear_evento_calendario(input) {
  try {
    const auth = getGoogleAuth(['https://www.googleapis.com/auth/calendar']);
    if (!auth) return { ok: false, error: 'Calendar no configurado' };
    const cal = google.calendar({ version: 'v3', auth });

    let eventBody = { summary: input.titulo, description: input.descripcion || '' };
  if (input.colorId) eventBody.colorId = input.colorId;

    if (input.todo_el_dia || !input.hora_inicio) {
      eventBody.start = { date: input.fecha };
      eventBody.end = { date: input.fecha };
    } else {
      const fin = input.hora_fin || sumarHora(input.hora_inicio, 1);
      eventBody.start = { dateTime: `${input.fecha}T${input.hora_inicio}:00`, timeZone: 'America/Argentina/Buenos_Aires' };
      eventBody.end = { dateTime: `${input.fecha}T${fin}:00`, timeZone: 'America/Argentina/Buenos_Aires' };
    }

    let resp;
    try {
      resp = await cal.events.insert({ calendarId: CALENDAR_ID, requestBody: eventBody });
    } catch (e) {
      resp = await cal.events.insert({ calendarId: 'primary', requestBody: eventBody });
    }

    await guardarHistorial(`Agendó: "${input.titulo}" el ${input.fecha}`, null);
    return { ok: true, titulo: input.titulo, fecha: input.fecha, hora: input.hora_inicio, id: resp.data.id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function tool_consultar_calendario(input) {
  try {
    const auth = getGoogleAuth(['https://www.googleapis.com/auth/calendar.readonly']);
    if (!auth) return { ok: false, error: 'Calendar no configurado' };
    const cal = google.calendar({ version: 'v3', auth });

    const { timeMin, timeMax } = getBuenosAiresDateRange(input.periodo);
    console.log(`📅 Calendar query: periodo=${input.periodo} | ${timeMin} → ${timeMax} | calendarId=${CALENDAR_ID}`);

    let eventos = [];
    try {
      const resp = await cal.events.list({ calendarId: CALENDAR_ID, timeMin, timeMax, singleEvents: true, orderBy: 'startTime', maxResults: 20 });
      eventos = resp.data.items || [];
      console.log(`📅 Eventos (${CALENDAR_ID}): ${eventos.length}`);
    } catch (e) {
      console.error(`⚠️ Calendar error con calendarId=${CALENDAR_ID}: ${e.message}`);
      try {
        const resp = await cal.events.list({ calendarId: 'primary', timeMin, timeMax, singleEvents: true, orderBy: 'startTime', maxResults: 20 });
        eventos = resp.data.items || [];
        console.log(`📅 Eventos (primary fallback): ${eventos.length}`);
      } catch (e2) {
        console.error(`⚠️ Calendar error con primary: ${e2.message}`);
        throw e2;
      }
    }

    return {
      periodo: input.periodo,
      cantidad: eventos.length,
      eventos: eventos.map(e => ({
        titulo: e.summary,
        fecha: e.start.date || e.start.dateTime?.split('T')[0],
        hora: e.start.dateTime ? new Date(e.start.dateTime).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' }) : 'Todo el día',
        id: e.id
      }))
    };
  } catch (e) {
    console.error('❌ tool_consultar_calendario:', e.message);
    return { ok: false, error: e.message };
  }
}

async function tool_buscar_en_drive(input) {
  try {
    const auth = getGoogleAuth(['https://www.googleapis.com/auth/drive.readonly']);
    if (!auth) return { ok: false, error: 'Drive no configurado' };
    const drive = google.drive({ version: 'v3', auth });

    let queryParts = [`fullText contains '${input.query}' or name contains '${input.query}'`];

    if (input.tipo && input.tipo !== 'cualquiera') {
      const mimeTypes = {
        'documento': 'application/vnd.google-apps.document',
        'hoja de calculo': 'application/vnd.google-apps.spreadsheet',
        'presentacion': 'application/vnd.google-apps.presentation',
        'pdf': 'application/pdf'
      };
      if (mimeTypes[input.tipo]) queryParts.push(`mimeType = '${mimeTypes[input.tipo]}'`);
    }

    const resp = await drive.files.list({
      q: queryParts.join(' and '),
      pageSize: 10,
      fields: 'files(id, name, mimeType, webViewLink, modifiedTime)',
      orderBy: 'modifiedTime desc'
    });

    const archivos = (resp.data.files || []).map(f => ({
      nombre: f.name,
      tipo: f.mimeType,
      link: f.webViewLink,
      modificado: f.modifiedTime?.split('T')[0]
    }));

    return { query: input.query, cantidad: archivos.length, archivos };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function tool_plan_del_dia() {
  try {
    const hoy = fechaISO();
    const [tareas, calendario] = await Promise.all([
      tool_consultar_tareas({ filtro: 'hoy' }),
      tool_consultar_calendario({ periodo: 'hoy' })
    ]);
    return { fecha: hoy, tareas: tareas.tareas || [], eventos: calendario.eventos || [] };
  } catch (e) {
    return { error: e.message };
  }
}

// ─── Ejecutar herramienta ─────────────────────────────────────────────────────
async function ejecutarHerramienta(nombre, input) {
  console.log(`🔧 Ejecutando: ${nombre}`, JSON.stringify(input).substring(0, 100));
  switch (nombre) {
    case 'crear_tarea_notion':        return await tool_crear_tarea_notion(input);
    case 'buscar_y_marcar_hecha':     return await tool_buscar_y_marcar_hecha(input);
    case 'consultar_tareas':          return await tool_consultar_tareas(input);
    case 'editar_tarea':              return await tool_editar_tarea(input);
    case 'crear_evento_calendario':   return await tool_crear_evento_calendario(input);
    case 'consultar_calendario':      return await tool_consultar_calendario(input);
    case 'buscar_en_drive':           return await tool_buscar_en_drive(input);
    case 'plan_del_dia':              return await tool_plan_del_dia();
    default: return { error: `Herramienta desconocida: ${nombre}` };
  }
}

// ─── Loop principal de Claude con tool use ────────────────────────────────────
async function procesarConClaude(chatId, userText) {
  const historial = obtenerHistorial(chatId);

  // Agregar mensaje del usuario
  const mensajes = [
    ...historial,
    { role: 'user', content: userText }
  ];

  let respuestaFinal = null;
  let iteraciones = 0;
  const MAX_ITERACIONES = 5;

  while (iteraciones < MAX_ITERACIONES) {
    iteraciones++;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: buildSystemPrompt(),
      tools: TOOLS,
      messages: mensajes
    });

    console.log(`🤖 Claude stop_reason: ${response.stop_reason}`);

    if (response.stop_reason === 'end_turn') {
      // Claude terminó — extraer texto de respuesta
      const texto = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');
      respuestaFinal = texto;
      
      // Guardar en historial de sesión
      mensajes.push({ role: 'assistant', content: response.content });
      break;
    }

    if (response.stop_reason === 'tool_use') {
      // Claude quiere usar herramientas
      mensajes.push({ role: 'assistant', content: response.content });

      // Ejecutar todas las herramientas que pidió
      const toolResults = [];
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          const resultado = await ejecutarHerramienta(block.name, block.input);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(resultado)
          });
        }
      }

      // Agregar resultados y continuar el loop
      mensajes.push({ role: 'user', content: toolResults });
    }
  }

  // Actualizar historial de sesión con los últimos mensajes
  const historialActualizado = mensajes.slice(-MAX_MENSAJES);
  memoriaSession.set(chatId, historialActualizado);

  return respuestaFinal || '❌ No pude procesar tu mensaje.';
}

// ─── Guardar en historial Notion ──────────────────────────────────────────────
async function guardarHistorial(texto, contexto) {
  try {
    const fecha = new Date().toLocaleDateString('es-AR', {
      timeZone: 'America/Argentina/Buenos_Aires',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });

    await notion.blocks.children.append({
      block_id: NOTION_HISTORIAL_ID,
      children: [{
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [
            { type: 'text', text: { content: `[${fecha}] ` }, annotations: { bold: true } },
            { type: 'text', text: { content: texto } }
          ]
        }
      }]
    });
  } catch (e) {
    // No fallar si no se puede guardar historial
  }
}

// ─── Telegram ─────────────────────────────────────────────────────────────────
async function enviarTelegram(chatId, texto) {
  try {
    // Limpiar markdown de Claude que Telegram no entiende
    const textoLimpio = texto
      .replace(/\*\*(.*?)\*\*/g, '*$1*')  // Bold
      .replace(/#{1,3} /g, '')             // Headers
      .substring(0, 4096);                 // Límite Telegram

    const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: textoLimpio,
        parse_mode: 'Markdown'
      })
    });
    const data = await resp.json();
    if (!data.ok) {
      // Si falla con Markdown, intentar sin formato
      await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: texto.substring(0, 4096) })
      });
    }
  } catch (e) {
    console.error('❌ Error Telegram:', e.message);
  }
}

async function transcribirGroq(fileId) {
  try {
    const fileRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
    const fileData = await fileRes.json();
    if (!fileData.ok) return null;

    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileData.result.file_path}`;
    const audioRes = await fetch(fileUrl);
    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

    const formData = new FormData();
    formData.append('file', new Blob([audioBuffer], { type: 'audio/ogg' }), 'audio.ogg');
    formData.append('model', 'whisper-large-v3-turbo');
    formData.append('language', 'es');
    formData.append('response_format', 'json');

    const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` },
      body: formData
    });

    const data = await resp.json();
    return data.text || null;
  } catch (e) {
    console.error('❌ Groq error:', e.message);
    return null;
  }
}

// ─── Webhook Telegram ─────────────────────────────────────────────────────────
app.post('/webhook/telegram', async (req, res) => {
  res.status(200).send('');

  try {
    const update = req.body;
    const message = update.message || update.edited_message;
    if (!message) return;

    const chatId = message.chat.id;
    let userText = null;

    if (message.text) {
      userText = message.text.trim();
    } else if (message.voice || message.audio) {
      const fileId = message.voice?.file_id || message.audio?.file_id;
      if (fileId) {
        await enviarTelegram(chatId, '🎙️ _Transcribiendo..._');
        userText = await transcribirGroq(fileId);
        if (!userText) {
          await enviarTelegram(chatId, '❌ No pude transcribir el audio.');
          return;
        }
        await enviarTelegram(chatId, `📝 _"${userText}"_`);
      }
    } else {
      return;
    }

    if (!userText) return;
    console.log('💬 Lucas:', userText);

    // Agregar al historial y procesar
    agregarMensaje(chatId, 'user', userText);

    procesarConClaude(chatId, userText)
      .then(respuesta => {
        console.log('📤 Respuesta lista');
        return enviarTelegram(chatId, respuesta);
      })
      .catch(async e => {
        console.error('❌ Error procesando:', e.message);
        await enviarTelegram(chatId, `❌ Error: ${e.message}`);
      });

  } catch (e) {
    console.error('❌ Webhook error:', e.message);
  }
});

// ─── Google Chat (mantener por compatibilidad) ────────────────────────────────
app.post('/webhook/google-chat', async (req, res) => {
  res.status(200).send('');
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'running', version: '6.0.0', model: 'claude-sonnet-4-6' });
});

// ─── Iniciar ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Segundo Cerebro Bot v6.0 en puerto ${PORT}`);
  console.log(`🤖 Modelo: claude-sonnet-4-6`);
  console.log(`📋 Notion: ${NOTION_DB_ID}`);
  console.log(`📅 Calendar: ${CALENDAR_ID}`);
  console.log(`📚 Historial: ${NOTION_HISTORIAL_ID}`);
  console.log(`📱 Telegram: ${TELEGRAM_TOKEN ? '✅' : '❌'}`);
  console.log(`🎙️ Groq: ${GROQ_API_KEY ? '✅' : '❌'}`);
});
