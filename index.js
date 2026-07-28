/**
 * SEGUNDO CEREBRO BOT v7.0
 * Secretario personal de Lucas Hernán Laurenzano
 *
 * Arquitectura: Tool Use nativo de Claude
 * Claude decide qué herramientas usar en cada conversación.
 * No hay intenciones predefinidas ni JSON estructurado.
 *
 * v7.0 (2026-07-28): optimizaciones portadas del bot Caja Hermanos —
 * procesamiento dentro del request, prompt caching con ttl 1h, prefetch de
 * Notion en paralelo con Claude, whitelist + secret token del webhook,
 * dedupe de updates, entrega garantizada a Telegram y warm-up al arrancar.
 */

const express = require('express');
const bodyParser = require('body-parser');
const Anthropic = require('@anthropic-ai/sdk');
const { Client } = require('@notionhq/client');
// Carga selectiva: require('googleapis') completo tarda ~2,4 s (112 MB) y era la
// mayor parte del cold start. Cargar solo auth + calendar + drive tarda ~0,3 s.
const { OAuth2Client } = require('google-auth-library');
const { calendar: calendarApi } = require('googleapis/build/src/apis/calendar');
const { drive: driveApi } = require('googleapis/build/src/apis/drive');
require('dotenv').config();

const app = express();
app.use(bodyParser.json({ limit: '10mb' }));

// ─── Clientes ────────────────────────────────────────────────────────────────
// timeout 30 s: mejor fallar rápido y visible que dejar a Lucas esperando los
// 10 minutos del default del SDK. maxRetries 2 por la misma razón (el SDK
// reintenta 429/5xx con backoff exponencial respetando el header retry-after).
const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY, timeout: 30_000, maxRetries: 2 });
const notion = new Client({ auth: process.env.NOTION_TOKEN });

// Modelo por env para poder cambiarlo sin tocar código (y que /health no mienta).
// Sonnet 5 con thinking adaptive: acá se agenda y se borran tareas reales, y la
// diferencia de costo es marginal con el volumen de un solo usuario.
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
const EFFORT = process.env.CLAUDE_EFFORT || 'medium';

const NOTION_DB_ID = process.env.NOTION_DATABASE_ID;
// Base P.A.R.A (Proyectos/Areas/Recursos/Archivados). El env var NOTION_PROJECTS_DATABASE_ID
// apuntaba a una página, no a la base — usamos el ID real de la base con fallback al env var.
const NOTION_PROYECTOS_DB = '2fe6046f0fee8143b7c4d3027c702d36';
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'lucas@dlaurenzano.com';
const NOTION_HISTORIAL_ID = '3626046f0fee80188b21c9964d5610f7';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// ─── Memoria de sesión ────────────────────────────────────────────────────────
// Guardamos los mensajes "crudos" recientes (incluyendo bloques tool_use/tool_result)
// y, cuando se pasan del límite, los más viejos se compactan en un resumen de texto
// que se inyecta en el system prompt. Así el contexto es largo y nunca se pierde del todo.
const memoriaSession = new Map();       // chatId -> array de mensajes Anthropic
const resumenSession = new Map();       // chatId -> string (resumen de lo más viejo)
const pendientesCompactar = new Map();  // chatId -> mensajes descartados aún sin resumir
const KEEP_MSGS = 30;                   // mensajes crudos recientes que mantenemos

function obtenerHistorial(chatId) {
  return memoriaSession.get(chatId) || [];
}

function obtenerResumen(chatId) {
  return resumenSession.get(chatId) || '';
}

// Un mensaje sirve como inicio de la ventana solo si es un 'user' de TEXTO
// (no un tool_result y no un assistant). Esto evita el error 400 de Anthropic:
// "unexpected tool_use_id ... must have a corresponding tool_use block".
function esInicioValido(m) {
  if (!m || m.role !== 'user') return false;
  if (typeof m.content === 'string') return true;
  return Array.isArray(m.content) && !m.content.some(b => b && b.type === 'tool_result');
}

// Recorta a los últimos KEEP_MSGS mensajes SIN dejar tool_result huérfanos al inicio.
// Devuelve { ventana, descartados } para poder compactar lo que sale.
function recortarSeguro(mensajes) {
  let inicio = Math.max(0, mensajes.length - KEEP_MSGS);
  // Avanzar hasta que el primer mensaje de la ventana sea un 'user' de texto
  while (inicio < mensajes.length && !esInicioValido(mensajes[inicio])) inicio++;
  // Si nos pasamos de largo (no hay user de texto), conservar todo desde el último user de texto
  if (inicio >= mensajes.length) {
    let i = mensajes.length - 1;
    while (i >= 0 && !esInicioValido(mensajes[i])) i--;
    inicio = i >= 0 ? i : 0;
  }
  return { ventana: mensajes.slice(inicio), descartados: mensajes.slice(0, inicio) };
}

// Convierte mensajes descartados en texto plano legible para el resumen.
function mensajesATexto(mensajes) {
  const lineas = [];
  for (const m of mensajes) {
    if (typeof m.content === 'string') {
      lineas.push(`${m.role === 'user' ? 'Lucas' : 'Bot'}: ${m.content}`);
    } else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'text') lineas.push(`Bot: ${b.text}`);
        else if (b.type === 'tool_use') lineas.push(`Bot[acción ${b.name}]: ${JSON.stringify(b.input)}`);
        else if (b.type === 'tool_result') {
          const c = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
          lineas.push(`Resultado: ${c?.substring(0, 300)}`);
        }
      }
    }
  }
  return lineas.join('\n');
}

// Compacta (resumen previo + mensajes descartados) en un nuevo resumen conciso.
// Usa Haiku para no encarecer; si falla, cae a una concatenación heurística acotada.
//
// Se llama DESPUÉS de responderle a Lucas (fuera de la ruta crítica): antes se
// hacía en medio del turno y le sumaba una llamada entera a la espera.
// procesarConClaude solo deja lo pendiente anotado en pendientesCompactar.
async function compactarPendiente(chatId) {
  const descartados = pendientesCompactar.get(chatId);
  if (!descartados || !descartados.length) return;
  pendientesCompactar.delete(chatId);
  const previo = obtenerResumen(chatId);
  const nuevoTexto = mensajesATexto(descartados);
  try {
    const r = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: 'Sos un compactador de memoria. Resumí la conversación entre Lucas y su bot secretario en español, en bullets concisos. Preservá SIEMPRE: tareas/eventos/proyectos mencionados, decisiones tomadas, datos concretos (fechas, nombres, montos) y cualquier cosa pendiente. Omití saludos y relleno.',
      messages: [{
        role: 'user',
        content: `RESUMEN PREVIO:\n${previo || '(vacío)'}\n\nNUEVOS MENSAJES A INTEGRAR:\n${nuevoTexto}\n\nDevolvé el resumen actualizado y unificado.`
      }]
    });
    const txt = r.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    if (txt) resumenSession.set(chatId, txt.substring(0, 6000));
  } catch (e) {
    console.error('⚠️ Compactación falló, uso heurística:', e.message);
    const combinado = `${previo}\n${nuevoTexto}`.trim();
    resumenSession.set(chatId, combinado.slice(-6000));
  }
}

// ─── Google Auth ──────────────────────────────────────────────────────────────
// El cliente OAuth y los clientes de API se construyen una sola vez: rearmarlos
// en cada tool obliga a rehacer el handshake TLS y a refrescar el access token.
let authCache = null;
function getGoogleAuth() {
  if (authCache) return authCache;
  try {
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
    if (!clientId || !clientSecret || !refreshToken) return null;
    const auth = new OAuth2Client(clientId, clientSecret);
    auth.setCredentials({ refresh_token: refreshToken });
    authCache = auth;
    return auth;
  } catch (e) {
    console.error('⚠️ Google Auth error:', e.message);
    return null;
  }
}

let calendarCache = null;
function getCalendar() {
  const auth = getGoogleAuth();
  if (!auth) return null;
  if (!calendarCache) calendarCache = calendarApi({ version: 'v3', auth });
  return calendarCache;
}

let driveCache = null;
function getDrive() {
  const auth = getGoogleAuth();
  if (!auth) return null;
  if (!driveCache) driveCache = driveApi({ version: 'v3', auth });
  return driveCache;
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

// Suma minutos a un "HH:MM" y devuelve "HH:MM" (sin cruzar de día; clamp simple).
function sumarMinutos(h, min) {
  const [hh, mm] = h.split(':').map(Number);
  let total = hh * 60 + mm + min;
  total = Math.max(0, Math.min(total, 23 * 60 + 59));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// Argentina es siempre UTC-3, sin DST
function getBuenosAiresDateRange(periodo) {
  const TZ = 'America/Argentina/Buenos_Aires';
  const OFFSET = '-03:00';
  const hoyStr = new Date().toLocaleDateString('en-CA', { timeZone: TZ });

  // Anclar a mediodía Buenos Aires para sumar días sin cruces de medianoche UTC
  const ancla = new Date(`${hoyStr}T12:00:00${OFFSET}`).getTime();
  const DIA = 24 * 60 * 60 * 1000;

  if (periodo === 'hoy') {
    return { timeMin: `${hoyStr}T00:00:00${OFFSET}`, timeMax: `${hoyStr}T23:59:59${OFFSET}` };
  }
  if (periodo === 'mañana') {
    const manStr = new Date(ancla + DIA).toLocaleDateString('en-CA', { timeZone: TZ });
    return { timeMin: `${manStr}T00:00:00${OFFSET}`, timeMax: `${manStr}T23:59:59${OFFSET}` };
  }
  // semana
  const en7Str = new Date(ancla + 7 * DIA).toLocaleDateString('en-CA', { timeZone: TZ });
  return { timeMin: `${hoyStr}T00:00:00${OFFSET}`, timeMax: `${en7Str}T23:59:59${OFFSET}` };
}

// ─── Cache de proyectos (base P.A.R.A) ─────────────────────────────────────────
let proyectosCache = { ts: 0, porId: new Map(), lista: [] };
const PROYECTOS_TTL = 5 * 60 * 1000;

async function cargarProyectos(forzar = false) {
  if (!forzar && Date.now() - proyectosCache.ts < PROYECTOS_TTL && proyectosCache.lista.length) {
    return proyectosCache;
  }
  try {
    const porId = new Map();
    const lista = [];
    let cursor = undefined;
    do {
      const resp = await notion.databases.query({
        database_id: NOTION_PROYECTOS_DB,
        start_cursor: cursor,
        page_size: 100
      });
      for (const p of resp.results) {
        const nombre = p.properties['Título']?.title?.[0]?.plain_text
          || p.properties['Título']?.title?.[0]?.text?.content || '(sin título)';
        const categoria = p.properties['Categoría P.A.R.A']?.select?.name || null;
        const estado = p.properties['Estado Proyecto']?.select?.name || null;
        porId.set(p.id, nombre);
        lista.push({ id: p.id, nombre, categoria, estado });
      }
      cursor = resp.has_more ? resp.next_cursor : undefined;
    } while (cursor);
    proyectosCache = { ts: Date.now(), porId, lista };
  } catch (e) {
    console.error('⚠️ cargarProyectos:', e.message);
  }
  return proyectosCache;
}

// Busca el ID de un proyecto por nombre (match flexible por palabras).
async function buscarProyectoId(nombre) {
  if (!nombre) return null;
  const { lista } = await cargarProyectos();
  const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const objetivo = norm(nombre);
  // 1) match exacto
  let m = lista.find(p => norm(p.nombre) === objetivo);
  if (m) return m;
  // 2) contiene
  m = lista.find(p => norm(p.nombre).includes(objetivo) || objetivo.includes(norm(p.nombre)));
  if (m) return m;
  // 3) por palabras significativas
  const palabras = objetivo.split(/\s+/).filter(p => p.length > 2);
  m = lista.find(p => palabras.some(w => norm(p.nombre).includes(w)));
  return m || null;
}

function mapTarea(page) {
  const relProyecto = page.properties['Proyecto']?.relation || [];
  const proyectoId = relProyecto[0]?.id || null;
  return {
    id: page.id,
    titulo: page.properties['Siguiente acción']?.title?.[0]?.text?.content
      || page.properties['Siguiente acción']?.title?.[0]?.plain_text || '',
    contexto: page.properties['Contexto']?.select?.name || null,
    proyecto: proyectoId ? (proyectosCache.porId.get(proyectoId) || null) : null,
    dia_accion: page.properties['Dia acción']?.date?.start || null,
    fecha_limite: page.properties['Fecha límite']?.date?.start || null,
    me_gustaria_hoy: page.properties['Me gustaría hoy']?.checkbox || false,
    en_espera: page.properties['En espera']?.date?.start || null
  };
}

// ─── System Prompt ────────────────────────────────────────────────────────────
// PROMPT CACHING: el prefijo se cachea por bytes exactos, así que el system está
// partido en dos bloques: uno ESTABLE (todo lo que no cambia nunca, con el
// breakpoint de cache y ttl 1h) y uno VOLÁTIL (la fecha, sin cache). El resumen
// de conversación NO va en el system: cambiaría el prefijo cada vez que se
// compacta e invalidaría el cache. Va como primer mensaje user.
// ⚠️ No usar {role:'system'} dentro de messages: Sonnet 5 no lo soporta (400).
function buildBloqueEstable() {
  return `Sos el secretario personal IA de Lucas Hernán Laurenzano.

QUIÉN ES LUCAS:
- CEO de DLP (Daniel Laurenzano Propiedades) - inmobiliaria
- Co-fundador de Smart Developments SRL - desarrolladora inmobiliaria
- Socio en Tuluka/Tuluvoto - gimnasio en Villa Devoto
- Vive en Buenos Aires con su pareja Julia y su hijo Vito
- Entrena lunes a viernes

TU ROL:
Sos su cerebro externo y secretario personal. Lucas NO tiene que mirar Notion, Calendar ni Drive — vos le decís todo y ejecutás todo. Hablás de manera directa, concisa y útil. No sos formal ni rígido. Usás emojis con moderación.

QUÉ PODÉS HACER (capacidades completas):
- Tareas Notion: CREAR, CONSULTAR, EDITAR, MARCAR HECHAS, BORRAR (archivar) y COMENTAR (informe).
- Calendario Google: CREAR, CONSULTAR y BORRAR eventos.
- Proyectos (base P.A.R.A): CREAR proyectos nuevos, LISTARLOS y VINCULAR tareas a un proyecto.
- Drive: buscar archivos.
SÍ podés borrar tareas y eventos. Nunca digas que solo podés agregar o modificar.

SISTEMA GTD EN NOTION:
- Toda tarea tiene: título (acción física), contexto, proyecto, fecha, prioridad
- Contextos (T = Trabajo, sin T = Personal):
  ROCA/T ROCA, Ordenador/T Ordenador, < 5 min/T < 5 min,
  Tarea manual casa, Energía baja, algún día/ a lo mejor/T algún día/ a lo mejor,
  Tarea fuera de casa, Leer/Revisar, T Leer/ Revisar,
  T Tarea manual oficina, T Tarea fuera oficina

PROYECTOS:
- Los proyectos viven en la base P.A.R.A. Usá consultar_proyectos para ver los reales.
- Si Lucas pide crear un proyecto nuevo, usá crear_proyecto. Después podés vincular tareas con el campo "proyecto" al crear/editar.
- Si al crear una tarea mencionás un proyecto que no existe, avisale a Lucas y ofrecé crearlo.

REGLAS IMPORTANTES:
1. Reescribí las tareas como acciones físicas concretas (verbo + objeto).
2. Inferí el contexto y proyecto más probable según el contenido.
3. FECHA + HORA EXACTA: cuando Lucas da fecha Y hora concretas, creá DOS cosas: el evento en Calendar Y la tarea en Notion (para relevar la info). Si da solo fecha (sin hora) o nada → solo tarea en Notion.
4. DESPUÉS DE CREAR un evento o una tarea con fecha, mostrale a Lucas TODO lo que tiene ese día (eventos del calendario + tareas), numerado. Para eso consultá calendario y tareas de esa fecha.
5. NUMERÁ SIEMPRE las listas de tareas y eventos (1, 2, 3...). Así Lucas puede pedir cambios diciendo "el 2" o "borrá el 3".
6. CONFIRMACIÓN ANTES DE EDITAR/BORRAR: para editar, borrar o comentar, primero buscá; mostrale a Lucas el título exacto que encontraste y PEDÍ CONFIRMACIÓN antes de ejecutar. Las herramientas de editar/borrar/comentar, cuando las llamás solo con "busqueda", te devuelven candidatos SIN ejecutar nada. Recién cuando Lucas confirma, llamalas de nuevo pasando el "id" del candidato elegido. Ej: pide "modificá la tasación de fran" y la tarea real es "Tasación departamento Franco" → preguntá "¿Te referís a 'Tasación departamento Franco'?" antes de tocar.
7. CORRECCIÓN DE PALABRAS: si una palabra parece un error de tipeo o de transcripción de audio (no existe en español o no tiene sentido en el contexto), preguntá "¿Quisiste decir X?" antes de actuar, en vez de adivinar.
8. COMENTARIOS/INFORME: cuando Lucas quiera dejar el informe o una nota de una tarea, usá comentar_tarea (agrega un comentario nativo en Notion). Típicamente: comentar el informe y recién después marcar la tarea como hecha.
9. Si Lucas dice "ya hice X", buscá esa tarea y marcala como hecha. Si no encontrás la exacta, buscá la más similar y confirmá.
10. Podés ejecutar múltiples herramientas en un solo mensaje. Esperá el resultado antes de responder. Respondé siempre en español argentino, directo y útil.
11. CONTEXTOS CON T (ej: T Ordenador, T ROCA) = TRABAJO. Sin T = PERSONAL.
   "del trabajo" → filtro "trabajo"; "personales" → filtro "personal"; en general → filtro "todas".
12. COLORES DE CALENDARIO al crear eventos:
   - Reuniones de trabajo, DLP, Smart, Tuluka → colorId "9" (Laboral, azul)
   - Personal, familia, Vito, Julia, amigos → colorId "5" (Personal, amarillo)
   - Gym, deporte, cursos, facultad, libros → colorId "4" (Desarrollo personal, rosa)
   - Viajes, traslados, autos → colorId "11" (Transporte, rojo)
13. CALENDARIO SIN LÍMITE DE FECHA: podés consultar cualquier día o rango futuro (o pasado), sin restricción. Para un día puntual usá "fecha"; para un rango usá "fecha_desde"+"fecha_hasta". Nunca digas que no podés ver una fecha lejana.
14. DURACIÓN DE EVENTOS: si Lucas no aclara cuánto dura, asumí 45 minutos (no pongas hora_fin y el sistema usa 45 min por defecto).
15. UBICACIÓN: lo que Lucas indique con "dónde", "en", "lugar" o una dirección va al campo "ubicacion" del evento (no a la descripción).`;
}

// Se arma una sola vez: es constante, y recalcularlo no aportaría nada.
const BLOQUE_ESTABLE = buildBloqueEstable();

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
        proyecto: { type: 'string', description: 'Nombre del proyecto a vincular (se busca en la base P.A.R.A). Opcional.' },
        dia_accion: { type: 'string', description: 'Fecha YYYY-MM-DD o null' },
        fecha_limite: { type: 'string', description: 'Fecha límite YYYY-MM-DD o null' },
        me_gustaria_hoy: { type: 'boolean', description: 'true si es para hacer hoy' },
        en_espera: { type: 'string', description: 'Fecha YYYY-MM-DD hasta la que queda en espera (es un campo de tipo fecha). Opcional.' }
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
          enum: ['hoy', 'mañana', 'semana', 'todas', 'en_espera', 'proyecto', 'trabajo', 'personal', 'fecha'],
          description: 'Qué tareas traer. "trabajo" = solo contextos con T. "personal" = solo contextos sin T. "proyecto" = de un proyecto. "fecha" = de un día puntual (usar campo fecha).'
        },
        proyecto: { type: 'string', description: 'Nombre del proyecto si filtro es "proyecto"' },
        fecha: { type: 'string', description: 'Fecha YYYY-MM-DD si filtro es "fecha"' }
      },
      required: ['filtro']
    }
  },
  {
    name: 'editar_tarea',
    description: 'Modifica una tarea existente en Notion. Si la llamás solo con "busqueda" devuelve candidatos SIN editar (para confirmar con Lucas). Para ejecutar el cambio pasá el "id" del candidato confirmado.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID de la tarea a editar (úsalo tras confirmar con Lucas). Si lo pasás, edita directo.' },
        busqueda: { type: 'string', description: 'Palabras clave para encontrar la tarea (devuelve candidatos para confirmar).' },
        cambios: {
          type: 'object',
          properties: {
            titulo: { type: 'string' },
            contexto: { type: 'string' },
            proyecto: { type: 'string', description: 'Nombre del proyecto a vincular' },
            dia_accion: { type: 'string' },
            fecha_limite: { type: 'string' },
            me_gustaria_hoy: { type: 'boolean' }
          }
        }
      },
      required: ['cambios']
    }
  },
  {
    name: 'comentar_tarea',
    description: 'Agrega un comentario (informe/nota) nativo de Notion a una tarea. Si la llamás solo con "busqueda" devuelve candidatos SIN comentar. Para ejecutar pasá el "id" confirmado. Útil para dejar el informe antes de marcar la tarea como hecha.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID de la tarea (úsalo tras confirmar).' },
        busqueda: { type: 'string', description: 'Palabras clave para encontrar la tarea (devuelve candidatos).' },
        comentario: { type: 'string', description: 'Texto del comentario/informe a agregar.' }
      },
      required: ['comentario']
    }
  },
  {
    name: 'crear_proyecto',
    description: 'Crea un proyecto nuevo en la base P.A.R.A de Notion.',
    input_schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'Nombre del proyecto' },
        estado: { type: 'string', enum: ['Activo', 'En Pausa', 'Futuro'], description: 'Estado del proyecto (default Activo)' }
      },
      required: ['nombre']
    }
  },
  {
    name: 'consultar_proyectos',
    description: 'Lista los proyectos existentes en la base P.A.R.A (para vincular tareas o ver cuáles hay).',
    input_schema: {
      type: 'object',
      properties: {
        solo_activos: { type: 'boolean', description: 'true para traer solo proyectos activos' }
      },
      required: []
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
        ubicacion: { type: 'string', description: 'Ubicación/dirección del evento (lo que Lucas diga con "dónde/en"). Va al campo Ubicación de Google Calendar.' },
        todo_el_dia: { type: 'boolean', description: 'true si es evento de todo el día' },
        colorId: { type: 'string', description: 'Color: 9=Laboral (azul), 5=Personal (amarillo), 4=Desarrollo personal (rosa), 11=Transporte (rojo)' }
      },
      required: ['titulo', 'fecha']
    }
  },
  {
    name: 'consultar_calendario',
    description: 'Consulta eventos del calendario de Lucas. SIN límite de fecha: podés consultar cualquier día o rango futuro (o pasado). Usá "periodo" (hoy/mañana/semana), "fecha" para un día puntual, o "fecha_desde"+"fecha_hasta" para un rango.',
    input_schema: {
      type: 'object',
      properties: {
        periodo: {
          type: 'string',
          enum: ['hoy', 'mañana', 'semana'],
          description: 'Período a consultar (ignorado si pasás "fecha" o un rango)'
        },
        fecha: { type: 'string', description: 'Fecha puntual YYYY-MM-DD (un solo día)' },
        fecha_desde: { type: 'string', description: 'Inicio del rango YYYY-MM-DD' },
        fecha_hasta: { type: 'string', description: 'Fin del rango YYYY-MM-DD' }
      },
      required: []
    }
  },
  {
    name: 'eliminar_evento_calendario',
    description: 'Elimina un evento del calendario. Si la llamás solo con "titulo" devuelve candidatos SIN borrar (para confirmar). Para ejecutar pasá el "id" del evento confirmado.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID del evento a borrar (úsalo tras confirmar con Lucas).' },
        titulo: { type: 'string', description: 'Título o palabras clave del evento (devuelve candidatos para confirmar).' }
      },
      required: []
    }
  },
  {
    name: 'eliminar_tarea_notion',
    description: 'Elimina (archiva) una tarea de Notion. Si la llamás solo con "busqueda" devuelve candidatos SIN borrar (para confirmar). Para ejecutar pasá el "id" confirmado.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID de la tarea a borrar (úsalo tras confirmar con Lucas).' },
        busqueda: { type: 'string', description: 'Palabras clave de la tarea (devuelve candidatos para confirmar).' }
      },
      required: []
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
    },
    // cache_control en la ÚLTIMA tool: cachea todo el bloque de tools (se renderiza
    // antes que system y messages). Las lecturas de cache no cuentan para el límite ITPM.
    // Si agregás tools nuevas, mové este cache_control a la nueva última tool.
    cache_control: { type: 'ephemeral' }
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
    // "En espera" es un campo de tipo FECHA en la base. Solo lo seteamos si parece YYYY-MM-DD.
    if (input.en_espera && /^\d{4}-\d{2}-\d{2}/.test(input.en_espera)) {
      properties['En espera'] = { date: { start: input.en_espera.substring(0, 10) } };
    }

    // Vincular proyecto (relation). Avisamos si el proyecto no existe.
    let proyectoVinculado = null;
    let proyectoNoEncontrado = null;
    if (input.proyecto) {
      const p = await buscarProyectoId(input.proyecto);
      if (p) { properties['Proyecto'] = { relation: [{ id: p.id }] }; proyectoVinculado = p.nombre; }
      else proyectoNoEncontrado = input.proyecto;
    }

    const page = await notion.pages.create({ parent: { database_id: NOTION_DB_ID }, properties });
    console.log('✅ Tarea creada:', input.titulo);

    // Guardar en historial
    await guardarHistorial(`Creó tarea: "${input.titulo}"`, input.contexto);

    return {
      ok: true, titulo: input.titulo, contexto: input.contexto || 'sin contexto',
      proyecto: proyectoVinculado, proyecto_no_encontrado: proyectoNoEncontrado, id: page.id
    };
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
    await cargarProyectos(); // para resolver nombres de proyecto en mapTarea
    const hoy = fechaISO();
    let tareas = [];

    if (input.filtro === 'fecha') {
      const dia = input.fecha || hoy;
      const resp = await notion.databases.query({
        database_id: NOTION_DB_ID,
        filter: {
          and: [
            { property: 'Hecho', checkbox: { equals: false } },
            { property: 'Dia acción', date: { equals: dia } }
          ]
        },
        page_size: 50
      });
      tareas = resp.results.map(mapTarea);
    } else if (input.filtro === 'proyecto') {
      const p = await buscarProyectoId(input.proyecto);
      if (!p) return { filtro: 'proyecto', error: `No encontré el proyecto "${input.proyecto}"`, cantidad: 0, tareas: [] };
      const resp = await notion.databases.query({
        database_id: NOTION_DB_ID,
        filter: {
          and: [
            { property: 'Hecho', checkbox: { equals: false } },
            { property: 'Proyecto', relation: { contains: p.id } }
          ]
        },
        sorts: [{ property: 'Dia acción', direction: 'ascending' }],
        page_size: 50
      });
      tareas = resp.results.map(mapTarea);
      return { filtro: 'proyecto', proyecto: p.nombre, cantidad: tareas.length, tareas };
    } else if (input.filtro === 'hoy') {
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
            { property: 'En espera', date: { is_not_empty: true } }
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

// Busca tareas pendientes por texto y devuelve candidatos {id, titulo, dia_accion, proyecto}.
async function buscarTareasCandidatas(busqueda, limite = 5) {
  const stopWords = ['tarea', 'hacer', 'con', 'por', 'para', 'sobre', 'borrar', 'eliminar', 'modificar', 'cambiar', 'editar', 'comentar', 'la', 'el', 'de', 'del'];
  const palabras = (busqueda || '').split(/\s+/).filter(p => p.length > 2 && !stopWords.includes(p.toLowerCase()));
  const vistos = new Set();
  const candidatos = [];
  await cargarProyectos();
  for (const palabra of palabras) {
    const resp = await notion.databases.query({
      database_id: NOTION_DB_ID,
      filter: {
        and: [
          { property: 'Hecho', checkbox: { equals: false } },
          { property: 'Siguiente acción', title: { contains: palabra } }
        ]
      },
      page_size: limite
    });
    for (const page of resp.results) {
      if (!vistos.has(page.id)) { vistos.add(page.id); candidatos.push(mapTarea(page)); }
    }
    if (candidatos.length >= limite) break;
  }
  return candidatos.slice(0, limite);
}

async function tool_editar_tarea(input) {
  try {
    // Sin id → devolver candidatos para que Lucas confirme (no editar).
    if (!input.id) {
      const candidatos = await buscarTareasCandidatas(input.busqueda);
      if (!candidatos.length) return { ok: false, mensaje: `No encontré tareas con "${input.busqueda}"` };
      return { ok: false, requiere_confirmacion: true, candidatos, instruccion: 'Mostrale estos candidatos a Lucas, pedí confirmación y volvé a llamar editar_tarea con el "id" elegido.' };
    }

    const properties = {};
    if (input.cambios.titulo) properties['Siguiente acción'] = { title: [{ text: { content: input.cambios.titulo } }] };
    if (input.cambios.contexto) properties['Contexto'] = { select: { name: input.cambios.contexto } };
    if (input.cambios.dia_accion) properties['Dia acción'] = { date: { start: input.cambios.dia_accion } };
    if (input.cambios.fecha_limite) properties['Fecha límite'] = { date: { start: input.cambios.fecha_limite } };
    if (input.cambios.me_gustaria_hoy !== undefined) properties['Me gustaría hoy'] = { checkbox: input.cambios.me_gustaria_hoy };

    let proyectoNoEncontrado = null;
    if (input.cambios.proyecto) {
      const p = await buscarProyectoId(input.cambios.proyecto);
      if (p) properties['Proyecto'] = { relation: [{ id: p.id }] };
      else proyectoNoEncontrado = input.cambios.proyecto;
    }

    await notion.pages.update({ page_id: input.id, properties });
    return { ok: true, id: input.id, cambios: input.cambios, proyecto_no_encontrado: proyectoNoEncontrado };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function tool_crear_evento_calendario(input) {
  try {
    const cal = getCalendar();
    if (!cal) return { ok: false, error: 'Calendar no configurado' };

    let eventBody = { summary: input.titulo, description: input.descripcion || '' };
    if (input.colorId) eventBody.colorId = input.colorId;
    if (input.ubicacion) eventBody.location = input.ubicacion;

    if (input.todo_el_dia || !input.hora_inicio) {
      eventBody.start = { date: input.fecha };
      eventBody.end = { date: input.fecha };
    } else {
      // Duración por defecto: 45 minutos si no se aclara hora_fin.
      const fin = input.hora_fin || sumarMinutos(input.hora_inicio, 45);
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
    return { ok: true, titulo: input.titulo, fecha: input.fecha, hora: input.hora_inicio, ubicacion: input.ubicacion || null, id: resp.data.id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function tool_consultar_calendario(input) {
  try {
    const cal = getCalendar();
    if (!cal) return { ok: false, error: 'Calendar no configurado' };

    // Sin límite de fecha: rango explícito > fecha puntual > periodo.
    let timeMin, timeMax, etiqueta;
    const esFecha = s => s && /^\d{4}-\d{2}-\d{2}/.test(s);
    if (esFecha(input.fecha_desde) || esFecha(input.fecha_hasta)) {
      const desde = esFecha(input.fecha_desde) ? input.fecha_desde.substring(0, 10) : fechaISO();
      const hasta = esFecha(input.fecha_hasta) ? input.fecha_hasta.substring(0, 10) : desde;
      timeMin = `${desde}T00:00:00-03:00`;
      timeMax = `${hasta}T23:59:59-03:00`;
      etiqueta = `${desde}→${hasta}`;
    } else if (esFecha(input.fecha)) {
      const d = input.fecha.substring(0, 10);
      timeMin = `${d}T00:00:00-03:00`;
      timeMax = `${d}T23:59:59-03:00`;
      etiqueta = d;
    } else {
      ({ timeMin, timeMax } = getBuenosAiresDateRange(input.periodo || 'hoy'));
      etiqueta = input.periodo || 'hoy';
    }
    console.log(`📅 Calendar query: ${etiqueta} | ${timeMin} → ${timeMax} | calendarId=${CALENDAR_ID}`);

    let eventos = [];
    try {
      const resp = await cal.events.list({ calendarId: CALENDAR_ID, timeMin, timeMax, singleEvents: true, orderBy: 'startTime', maxResults: 100 });
      eventos = resp.data.items || [];
      console.log(`📅 Eventos (${CALENDAR_ID}): ${eventos.length}`);
    } catch (e) {
      console.error(`⚠️ Calendar error con calendarId=${CALENDAR_ID}: ${e.message}`);
      try {
        const resp = await cal.events.list({ calendarId: 'primary', timeMin, timeMax, singleEvents: true, orderBy: 'startTime', maxResults: 100 });
        eventos = resp.data.items || [];
        console.log(`📅 Eventos (primary fallback): ${eventos.length}`);
      } catch (e2) {
        console.error(`⚠️ Calendar error con primary: ${e2.message}`);
        throw e2;
      }
    }

    return {
      periodo: etiqueta,
      cantidad: eventos.length,
      eventos: eventos.map(e => ({
        titulo: e.summary,
        fecha: e.start.date || e.start.dateTime?.split('T')[0],
        hora: e.start.dateTime ? new Date(e.start.dateTime).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' }) : 'Todo el día',
        ubicacion: e.location || null,
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
    const drive = getDrive();
    if (!drive) return { ok: false, error: 'Drive no configurado' };

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

async function tool_eliminar_evento_calendario(input) {
  try {
    const cal = getCalendar();
    if (!cal) return { ok: false, error: 'Calendar no configurado' };

    // Con id confirmado → borrar directo.
    if (input.id) {
      await cal.events.delete({ calendarId: CALENDAR_ID, eventId: input.id });
      await guardarHistorial(`Eliminó evento (id ${input.id})`, null);
      console.log('✅ Evento eliminado:', input.id);
      return { ok: true, id: input.id };
    }

    // Sin id → devolver candidatos para confirmar.
    const ahora = new Date();
    const en30 = new Date(ahora.getTime() + 30 * 24 * 60 * 60 * 1000);
    const resp = await cal.events.list({
      calendarId: CALENDAR_ID,
      timeMin: ahora.toISOString(),
      timeMax: en30.toISOString(),
      q: input.titulo,
      singleEvents: true,
      maxResults: 5
    });

    const eventos = resp.data.items || [];
    if (eventos.length === 0) return { ok: false, error: `No encontré eventos con "${input.titulo}"` };

    const candidatos = eventos.map(e => ({
      id: e.id,
      titulo: e.summary,
      fecha: e.start.date || e.start.dateTime?.split('T')[0],
      hora: e.start.dateTime ? new Date(e.start.dateTime).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' }) : 'Todo el día'
    }));
    return { ok: false, requiere_confirmacion: true, candidatos, instruccion: 'Mostrale estos eventos a Lucas, pedí confirmación y volvé a llamar eliminar_evento_calendario con el "id" elegido.' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function tool_eliminar_tarea_notion(input) {
  try {
    // Con id confirmado → archivar directo.
    if (input.id) {
      const page = await notion.pages.update({ page_id: input.id, archived: true });
      const titulo = page.properties?.['Siguiente acción']?.title?.[0]?.plain_text || '';
      await guardarHistorial(`Eliminó tarea: "${titulo}"`, null);
      console.log('✅ Tarea eliminada:', titulo || input.id);
      return { ok: true, id: input.id, titulo };
    }

    // Sin id → devolver candidatos para confirmar.
    const candidatos = await buscarTareasCandidatas(input.busqueda);
    if (!candidatos.length) return { ok: false, error: `No encontré tareas con "${input.busqueda}"` };
    return { ok: false, requiere_confirmacion: true, candidatos, instruccion: 'Mostrale estos candidatos a Lucas, pedí confirmación y volvé a llamar eliminar_tarea_notion con el "id" elegido.' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function tool_comentar_tarea(input) {
  try {
    // Con id confirmado → comentar directo.
    if (input.id) {
      await notion.comments.create({
        parent: { page_id: input.id },
        rich_text: [{ text: { content: input.comentario } }]
      });
      await guardarHistorial(`Comentó tarea (id ${input.id}): "${input.comentario.substring(0, 80)}"`, null);
      console.log('✅ Comentario agregado a', input.id);
      return { ok: true, id: input.id };
    }

    // Sin id → candidatos para confirmar.
    const candidatos = await buscarTareasCandidatas(input.busqueda);
    if (!candidatos.length) return { ok: false, error: `No encontré tareas con "${input.busqueda}"` };
    return { ok: false, requiere_confirmacion: true, candidatos, instruccion: 'Confirmá con Lucas a qué tarea y volvé a llamar comentar_tarea con el "id" elegido y el "comentario".' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function tool_crear_proyecto(input) {
  try {
    const properties = {
      'Título': { title: [{ text: { content: input.nombre } }] },
      'Categoría P.A.R.A': { select: { name: 'Proyecto' } },
      'Estado Proyecto': { select: { name: input.estado || 'Activo' } }
    };
    const page = await notion.pages.create({ parent: { database_id: NOTION_PROYECTOS_DB }, properties });
    await cargarProyectos(true); // refrescar cache para poder vincular ya mismo
    await guardarHistorial(`Creó proyecto: "${input.nombre}"`, null);
    console.log('✅ Proyecto creado:', input.nombre);
    return { ok: true, nombre: input.nombre, id: page.id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function tool_consultar_proyectos(input) {
  try {
    const { lista } = await cargarProyectos(true);
    let proyectos = lista.filter(p => p.categoria === 'Proyecto' || !p.categoria);
    if (input.solo_activos) proyectos = proyectos.filter(p => p.estado === 'Activo');
    return { cantidad: proyectos.length, proyectos: proyectos.map(p => ({ nombre: p.nombre, estado: p.estado })) };
  } catch (e) {
    return { ok: false, error: e.message };
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
    case 'comentar_tarea':            return await tool_comentar_tarea(input);
    case 'crear_proyecto':            return await tool_crear_proyecto(input);
    case 'consultar_proyectos':       return await tool_consultar_proyectos(input);
    case 'crear_evento_calendario':   return await tool_crear_evento_calendario(input);
    case 'consultar_calendario':      return await tool_consultar_calendario(input);
    case 'eliminar_evento_calendario': return await tool_eliminar_evento_calendario(input);
    case 'eliminar_tarea_notion':     return await tool_eliminar_tarea_notion(input);
    case 'buscar_en_drive':           return await tool_buscar_en_drive(input);
    case 'plan_del_dia':              return await tool_plan_del_dia();
    default: return { error: `Herramienta desconocida: ${nombre}` };
  }
}

// ─── Loop principal de Claude con tool use ────────────────────────────────────
async function procesarConClaude(chatId, userText) {
  const historial = obtenerHistorial(chatId);

  // El webhook ya NO agrega el mensaje del usuario: lo agregamos acá una sola vez.
  const mensajes = [
    ...historial,
    { role: 'user', content: userText }
  ];

  const bloqueFecha = `FECHA Y HORA ACTUAL: ${fechaHoy()} (${fechaISO()})`;

  // El resumen de conversación va como primer mensaje user (NO en el system:
  // cambiaría el prefijo cacheado). Es sintético: no se guarda en el historial.
  const resumen = obtenerResumen(chatId);
  const prefijo = resumen
    ? [{ role: 'user', content: `<contexto_previo>\nResumen de la conversación anterior (memoria de largo plazo, no la pierdas):\n${resumen}\n</contexto_previo>` }]
    : [];

  let respuestaFinal = null;
  let iteraciones = 0;
  const MAX_ITERACIONES = 8;
  const tiempos = [];

  while (iteraciones < MAX_ITERACIONES) {
    iteraciones++;
    const t = Date.now();

    const response = await anthropic.messages.create({
      model: MODEL,
      // Con thinking activo, max_tokens limita razonamiento + respuesta juntos.
      max_tokens: 8192,
      thinking: { type: 'adaptive' },
      output_config: { effort: EFFORT },
      // El breakpoint de cache va en el último bloque estable: cachea tools +
      // system de una (el orden de render es tools → system → messages).
      // ⚠️ Si algún día se cachean las tools, el ttl tiene que coincidir con éste.
      system: [
        { type: 'text', text: BLOQUE_ESTABLE, cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: bloqueFecha }
      ],
      tools: TOOLS,
      messages: [...prefijo, ...mensajes]
    });

    tiempos.push(Date.now() - t);
    const u = response.usage;
    console.log(`🤖 iter ${iteraciones}: ${Date.now() - t} ms | stop: ${response.stop_reason} | cache write: ${u?.cache_creation_input_tokens || 0} read: ${u?.cache_read_input_tokens || 0} input: ${u?.input_tokens || 0} output: ${u?.output_tokens || 0}`);

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

  console.log(`⏱ claude total: ${tiempos.reduce((a, b) => a + b, 0)} ms en ${tiempos.length} llamada/s`);

  // Recorte seguro (sin tool_result huérfanos); la compactación queda anotada
  // para después de responder (ver compactarPendiente en el webhook).
  const { ventana, descartados } = recortarSeguro(mensajes);
  memoriaSession.set(chatId, ventana);
  if (descartados.length) {
    const previos = pendientesCompactar.get(chatId) || [];
    pendientesCompactar.set(chatId, [...previos, ...descartados]);
  }

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
// Entrega garantizada: la red hacia api.telegram.org corta seguido, y una
// respuesta perdida acá no es solo molesta — Lucas se queda sin saber si la
// tarea se creó o el evento se borró. Dos capas: reintentos con espera
// creciente, y una cola que sigue insistiendo cuando el corte dura más.
async function postTelegram(metodo, payload, intentos = 4) {
  let ultimoError = null;
  for (let i = 1; i <= intentos; i++) {
    try {
      const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${metodo}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      return await resp.json();
    } catch (e) {
      ultimoError = e;
      if (i < intentos) await new Promise(r => setTimeout(r, 1500 * i));
    }
  }
  console.error(`⚠️ Telegram ${metodo} falló tras ${intentos} intentos: ${ultimoError?.message}`);
  return { ok: false, error_local: ultimoError?.message };
}

// Cola de mensajes que no se pudieron entregar. Se reintenta hasta 30 min.
const pendientes = [];
const MAX_PENDIENTES = 100;
const REINTENTO_MS = 20000;
const VIDA_MAX_MS = 30 * 60 * 1000;
let flusherActivo = false;

function encolar(chatId, texto) {
  if (pendientes.length >= MAX_PENDIENTES) pendientes.shift();
  pendientes.push({ chatId, texto, desde: Date.now() });
  console.log(`📬 Encolado para reintento (${pendientes.length} pendiente/s)`);
  iniciarFlusher();
}

function iniciarFlusher() {
  if (flusherActivo) return;
  flusherActivo = true;
  const timer = setInterval(async () => {
    if (!pendientes.length) { clearInterval(timer); flusherActivo = false; return; }
    const item = pendientes.shift();
    if (Date.now() - item.desde > VIDA_MAX_MS) {
      console.error('❌ Mensaje descartado tras 30 min sin poder entregarlo');
      return;
    }
    const r = await intentarEnvio(item.chatId, item.texto);
    if (r === 'ok') console.log(`✅ Mensaje pendiente entregado (${pendientes.length} restante/s)`);
    else if (r === 'red') pendientes.unshift(item); // sigue primero en la cola
    // 'permanente': se descarta, reintentar no va a ayudar
  }, REINTENTO_MS);
  timer.unref?.();
}

// Devuelve 'ok', 'red' (falla de red — reintentable) o 'permanente'
// (Telegram rechazó el mensaje: chat inexistente, bot bloqueado).
async function intentarEnvio(chatId, texto) {
  // Limpiar markdown de Claude que Telegram no entiende
  const textoLimpio = texto
    .replace(/\*\*(.*?)\*\*/g, '*$1*')  // Bold
    .replace(/#{1,3} /g, '')             // Headers
    .substring(0, 4096);                 // Límite Telegram

  const data = await postTelegram('sendMessage', {
    chat_id: chatId, text: textoLimpio, parse_mode: 'Markdown',
    link_preview_options: { is_disabled: true }
  });
  if (data.ok) return 'ok';
  if (data.error_local) return 'red';

  // Markdown mal balanceado: Telegram rechaza con 400. Reintentar sin formato.
  const plano = await postTelegram('sendMessage', {
    chat_id: chatId, text: texto.substring(0, 4096),
    link_preview_options: { is_disabled: true }
  });
  if (plano.ok) return 'ok';
  if (plano.error_local) return 'red';
  console.error(`❌ Telegram rechazó el mensaje para ${chatId}: ${plano.description || data.description || '?'}`);
  return 'permanente';
}

async function enviarTelegram(chatId, texto) {
  const r = await intentarEnvio(chatId, texto);
  if (r === 'red') encolar(chatId, texto); // solo cortes de red van a la cola
  return r === 'ok';
}

// Drenaje oportunista: en Cloud Run con CPU throttling el setInterval no corre
// entre requests, así que cada request nuevo intenta vaciar la cola pendiente.
async function drenarPendientes() {
  while (pendientes.length) {
    const item = pendientes.shift();
    if (Date.now() - item.desde > VIDA_MAX_MS) continue;
    const r = await intentarEnvio(item.chatId, item.texto);
    if (r === 'red') { pendientes.unshift(item); break; }
    if (r === 'ok') console.log(`✅ Mensaje pendiente entregado en drenaje (${pendientes.length} restante/s)`);
  }
}

// Warm-up al arrancar: abre la conexión TLS con Telegram para que el primer
// mensaje real no pague el handshake.
function warmupTelegram() {
  return postTelegram('getMe', {}, 1);
}

// "escribiendo…" mientras Claude procesa (expira solo a los ~5 s, se puede
// llamar repetido). Falla en silencio: es solo feedback visual.
async function accionEscribiendo(chatId) {
  await postTelegram('sendChatAction', { chat_id: chatId, action: 'typing' }, 1);
}

async function transcribirGroq(fileId) {
  try {
    // 1. Obtener path del archivo desde Telegram
    const fileRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
    const fileData = await fileRes.json();
    if (!fileData.ok) {
      console.error('❌ Groq: Telegram getFile falló:', JSON.stringify(fileData));
      return null;
    }

    const filePath = fileData.result.file_path;
    console.log(`🎙️ Descargando audio: ${filePath} (${fileData.result.file_size || '?'} bytes)`);

    // 2. Descargar audio
    const audioRes = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`);
    if (!audioRes.ok) {
      console.error(`❌ Groq: error descargando audio HTTP ${audioRes.status}`);
      return null;
    }
    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
    console.log(`🎙️ Audio descargado: ${audioBuffer.length} bytes`);

    // 3. Construir multipart manualmente (más confiable que FormData nativo en Node.js)
    const rawExt = filePath.split('.').pop() || 'ogg';
    const ext = rawExt === 'oga' ? 'ogg' : rawExt;  // Telegram usa .oga, Groq acepta .ogg
    const mimeType = ext === 'm4a' ? 'audio/mp4' : `audio/${ext}`;
    const boundary = `----Boundary${Date.now()}`;

    const partsText = [
      `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3-turbo`,
      `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nes`,
      `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson`,
    ].join('\r\n') + '\r\n';

    const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${ext}"\r\nContent-Type: ${mimeType}\r\n\r\n`;
    const closing = `\r\n--${boundary}--\r\n`;

    const body = Buffer.concat([
      Buffer.from(partsText),
      Buffer.from(fileHeader),
      audioBuffer,
      Buffer.from(closing)
    ]);

    // 4. Enviar a Groq
    const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      },
      body
    });

    const data = await resp.json();
    if (!resp.ok) {
      console.error(`❌ Groq API error ${resp.status}:`, JSON.stringify(data));
      return null;
    }

    console.log('✅ Transcripción OK:', data.text?.substring(0, 80));
    return data.text || null;
  } catch (e) {
    console.error('❌ Groq error:', e.message);
    return null;
  }
}

// ─── Autorización ─────────────────────────────────────────────────────────────
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';
const ALLOWED_USER_IDS = (process.env.TELEGRAM_ALLOWED_USER_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// Este bot tiene acceso de escritura al Notion y al Calendar de Lucas: un
// desconocido que encuentre el bot no puede quedar habilitado a usarlo.
// Sin whitelist configurada se deja pasar (fase de setup, para descubrir el
// user id por logs); en producción TELEGRAM_ALLOWED_USER_IDS va sí o sí.
function autorizado(message) {
  if (!ALLOWED_USER_IDS.length) return true;
  return ALLOWED_USER_IDS.includes(String(message.from?.id || ''));
}

// ─── Deduplicación de updates ─────────────────────────────────────────────────
// Telegram reintenta el webhook si no respondemos a tiempo; sin esto, un
// reintento puede crear la misma tarea dos veces o borrar dos eventos.
// ⚠️ Vive en memoria: solo funciona con UNA instancia. Si algún día se sube
// max-instances, hay que mover el dedupe a almacenamiento compartido.
const updatesVistos = new Set();
const MAX_UPDATES_VISTOS = 500;
function esDuplicado(updateId) {
  if (updateId === undefined) return false;
  if (updatesVistos.has(updateId)) return true;
  updatesVistos.add(updateId);
  if (updatesVistos.size > MAX_UPDATES_VISTOS) {
    updatesVistos.delete(updatesVistos.values().next().value);
  }
  return false;
}

// ─── Handler de updates (compartido por webhook y dev-polling) ───────────────
async function manejarUpdate(update) {
  const message = update.message || update.edited_message;
  if (!message) return;

  if (esDuplicado(update.update_id)) {
    console.log(`🔁 Update duplicado ignorado: ${update.update_id}`);
    return;
  }

  // Si quedaron mensajes sin entregar de antes, aprovechar este request.
  drenarPendientes().catch(() => {});

  const chatId = message.chat.id;
  const fromId = message.from?.id;

  if (!autorizado(message)) {
    console.log(`⛔ No autorizado: user ${fromId} (${message.from?.first_name}) en chat ${chatId}`);
    if (message.chat.type === 'private') await enviarTelegram(chatId, '🔒 Este bot es privado.');
    return;
  }

  const t0 = Date.now();
  let userText = null;

  if (message.text) {
    userText = message.text.trim();
  } else if (message.voice || message.audio) {
    const fileId = message.voice?.file_id || message.audio?.file_id;
    if (fileId) {
      void accionEscribiendo(chatId);
      userText = await transcribirGroq(fileId);
      if (!userText) {
        await enviarTelegram(chatId, '❌ No pude transcribir el audio.');
        return;
      }
      // Eco de la transcripción sin bloquear el arranque de Claude.
      void enviarTelegram(chatId, `📝 _"${userText}"_`);
    }
  } else {
    return; // fotos, stickers, etc.
  }

  if (!userText) return;
  console.log(`💬 Lucas (${fromId}): ${userText}`);

  // "escribiendo…" sin bloquear, y la base P.A.R.A precargada en paralelo con
  // Claude: cuando una tool necesite resolver un proyecto, ya va a estar en cache.
  void accionEscribiendo(chatId);
  void cargarProyectos().catch(() => {});

  try {
    const respuesta = await procesarConClaude(chatId, userText);
    const tClaude = Date.now() - t0;
    await enviarTelegram(chatId, respuesta);
    console.log(`⏱ mensaje completo: total=${Date.now() - t0} ms (claude+tools=${tClaude} ms, telegram=${Date.now() - t0 - tClaude} ms)`);
  } catch (e) {
    console.error('❌ Error procesando:', e.message);
    await enviarTelegram(chatId, '❌ Se me trabó algo procesando eso. Probá de nuevo en un rato.');
  }

  // Compactación de memoria DESPUÉS de responder: Lucas no la espera, y al
  // correr dentro del request todavía tiene CPU asignada.
  try { await compactarPendiente(chatId); } catch (e) { console.error('⚠️ compactar:', e.message); }
}

// ─── Webhook Telegram ─────────────────────────────────────────────────────────
// Se procesa DENTRO del request (200 al final): así el trabajo corre con CPU
// asignada — Cloud Run estrangula la CPU fuera de los requests, que era la causa
// principal de la lentitud. Telegram espera ~60 s; nuestro peor caso es ~10 s.
// El Promise.race de 25 s es un paracaídas: si algo se colgara respondemos 200
// igual y el dedupe descarta el reintento.
app.post('/webhook/telegram', async (req, res) => {
  // Validar secret token: nadie puede inyectar updates falsos aunque tenga la URL.
  if (WEBHOOK_SECRET && req.get('X-Telegram-Bot-Api-Secret-Token') !== WEBHOOK_SECRET) {
    console.log('⛔ Webhook con secret token inválido');
    return res.status(403).send('');
  }

  try {
    await Promise.race([
      manejarUpdate(req.body),
      new Promise(resolve => setTimeout(resolve, 25_000))
    ]);
  } catch (e) {
    console.error('❌ Webhook error:', e.message);
  }
  res.status(200).send('');
});

// ─── Google Chat (mantener por compatibilidad) ────────────────────────────────
app.post('/webhook/google-chat', async (req, res) => {
  res.status(200).send('');
});

// ─── Health check ─────────────────────────────────────────────────────────────
// Reporta el modelo REAL: antes decía sonnet-4-6 mientras el loop usaba Haiku.
const NOTION_TOKEN_OK = !!process.env.NOTION_TOKEN;

app.get('/health', (req, res) => {
  res.json({
    status: 'running',
    version: '7.0.0',
    model: MODEL,
    effort: EFFORT,
    notion: NOTION_TOKEN_OK ? '✅' : '❌',
    calendar: getGoogleAuth() ? '✅' : '❌',
    whitelist_usuarios: ALLOWED_USER_IDS.length,
    secret_webhook: WEBHOOK_SECRET ? '✅' : '(sin secret)'
  });
});

// ─── Iniciar ──────────────────────────────────────────────────────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 8080;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Segundo Cerebro Bot v7.0 en puerto ${PORT}`);
    console.log(`🤖 Modelo: ${MODEL} (effort ${EFFORT})`);
    console.log(`📋 Notion: ${NOTION_DB_ID}`);
    console.log(`📅 Calendar: ${CALENDAR_ID}`);
    console.log(`📚 Historial: ${NOTION_HISTORIAL_ID}`);
    console.log(`📱 Telegram: ${TELEGRAM_TOKEN ? '✅' : '❌'}`);
    console.log(`🎙️ Groq: ${GROQ_API_KEY ? '✅' : '❌'}`);
    console.log(`🔐 Secret webhook: ${WEBHOOK_SECRET ? '✅' : '⚠️ sin secret'}`);
    console.log(`👥 Usuarios autorizados: ${ALLOWED_USER_IDS.length || '⚠️ TODOS (setear TELEGRAM_ALLOWED_USER_IDS)'}`);

    // Warm-up: abrir TLS con Notion y Telegram y precargar la base P.A.R.A,
    // para que el primer mensaje real no pague los handshakes. Sin bloquear el boot.
    cargarProyectos()
      .then(c => console.log(`🔥 Warm-up Notion OK (${c.lista.length} proyectos)`))
      .catch(e => console.error('⚠️ Warm-up Notion:', e.message));
    warmupTelegram().then(d => console.log(`🔥 Warm-up Telegram ${d?.ok ? 'OK' : 'falló'}`)).catch(() => {});
  });
}

module.exports = { manejarUpdate };
