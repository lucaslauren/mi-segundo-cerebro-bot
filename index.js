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

// Suma días a una fecha ISO (YYYY-MM-DD) anclando al mediodía de Buenos Aires:
// sumar sobre medianoche cruza de día al pasar por UTC y devuelve el día equivocado.
function sumarDiasISO(iso, dias) {
  const t = new Date(`${iso}T12:00:00-03:00`).getTime() + dias * 24 * 60 * 60 * 1000;
  return new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
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

// ─── Notion: paginación ───────────────────────────────────────────────────────
// databases.query devuelve como máximo 100 páginas por request. Antes NINGUNA
// consulta miraba has_more y varias pedían page_size 50: con más de 50 pendientes
// el bot decía "tenés 50" cuando había 80, sin ningún aviso. Toda consulta de
// tareas pasa por acá.
async function queryTodas(args, maxPaginas = 20) {
  const resultados = [];
  let cursor;
  for (let i = 0; i < maxPaginas; i++) {
    const resp = await notion.databases.query({ ...args, page_size: 100, start_cursor: cursor });
    resultados.push(...resp.results);
    if (!resp.has_more) return resultados;
    cursor = resp.next_cursor;
  }
  console.warn(`⚠️ queryTodas cortó en ${maxPaginas} páginas (${resultados.length} resultados)`);
  return resultados;
}

// ─── Matching de tareas por texto ─────────────────────────────────────────────
// Antes se hacía una query HTTP a Notion POR CADA PALABRA hasta el primer hit, y
// buscar_y_marcar_hecha se quedaba con resp.results[0] sin preguntar: con tres
// tareas que dijeran "Franco" marcaba la que Notion devolviera primero. Ahora se
// lee la lista de pendientes una vez (cacheada) y se puntúa en memoria.

// \p{Mn} = "nonspacing mark": exactamente lo que NFD deja suelto al descomponer
// una vocal acentuada. Se usa la propiedad Unicode en vez del rango de caracteres
// crudos que hay más abajo en el archivo: esos bytes son invisibles en el editor
// y cualquier reencodeo del archivo los rompe en silencio.
const TILDES = /\p{Mn}/gu;

function normalizar(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(TILDES, '')   // saca tildes; ñ→n, útil para matchear
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// Verbos que aparecen en CASI TODAS las tareas GTD ("Llamar a...", "Revisar...")
// y también en cómo Lucas las pide ("ya llamé a Franco"). Sin filtrarlos, la
// palabra que más pesa es justo la que no distingue nada.
const STOP_WORDS = new Set([
  'hablar', 'hable', 'llamar', 'llame', 'reunir', 'reunion', 'contactar', 'registrar',
  'hacer', 'hice', 'mandar', 'mande', 'enviar', 'envie', 'ver', 'revisar', 'revise',
  'terminar', 'termine', 'arreglar', 'arregle', 'comprar', 'compre', 'pasar', 'pase',
  'tarea', 'tareas', 'borrar', 'eliminar', 'modificar', 'cambiar', 'editar', 'comentar',
  'marcar', 'con', 'por', 'para', 'sobre', 'del', 'las', 'los', 'una', 'uno', 'que', 'ya'
]);

function palabrasSignificativas(texto) {
  return [...new Set(normalizar(texto).split(' '))]
    .filter(p => p.length >= 3 && !STOP_WORDS.has(p));
}

// Levenshtein con corte temprano: solo nos interesa saber si la distancia es ≤2
// (typos de tipeo y errores de transcripción de Whisper). Más allá devuelve 99.
function distancia(a, b, max = 2) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const fila = [i];
    let minFila = i;
    for (let j = 1; j <= b.length; j++) {
      const costo = a[i - 1] === b[j - 1] ? 0 : 1;
      fila[j] = Math.min(prev[j] + 1, fila[j - 1] + 1, prev[j - 1] + costo);
      if (fila[j] < minFila) minFila = fila[j];
    }
    if (minFila > max) return 99;  // ninguna continuación puede bajar de acá
    prev = fila;
  }
  return prev[b.length];
}

// Puntúa una tarea contra un texto de búsqueda. Devuelve 0 si no matchea nada.
function puntuarTarea(tarea, busqueda, hoyISO) {
  const objetivo = normalizar(busqueda);
  if (!objetivo) return 0;
  const titulo = normalizar(tarea.titulo);
  const secundario = normalizar(`${tarea.proyecto || ''} ${tarea.contexto || ''} ${tarea.nota || ''}`);
  const palabras = palabrasSignificativas(busqueda);
  const palabrasTitulo = titulo.split(' ');

  let score = 0;
  if (titulo.includes(objetivo)) score += 10;

  for (const p of palabras) {
    if (titulo.includes(p)) score += 3;
    else if (secundario.includes(p)) score += 1;
    // Typo: solo vale la pena sobre palabras largas (en cortas, distancia 2 es ruido).
    else if (p.length >= 5 && palabrasTitulo.some(t => t.length >= 5 && distancia(p, t) <= 2)) score += 2;
  }

  if (score === 0) return 0;
  if (tarea.dia_accion && tarea.dia_accion <= hoyISO) score += 1;   // lo que está en juego hoy
  if (tarea.hecho) score -= 2;  // una pendiente siempre le gana a una ya cerrada
  return score;
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
  const objetivo = normalizar(nombre);
  // 1) match exacto
  let m = lista.find(p => normalizar(p.nombre) === objetivo);
  if (m) return m;
  // 2) contiene
  m = lista.find(p => normalizar(p.nombre).includes(objetivo) || objetivo.includes(normalizar(p.nombre)));
  if (m) return m;
  // 3) por palabras significativas
  const palabras = objetivo.split(/\s+/).filter(p => p.length > 2);
  m = lista.find(p => palabras.some(w => normalizar(p.nombre).includes(w)));
  return m || null;
}

// El mapa de proyectos se recibe por parámetro en vez de leer proyectosCache
// global: si cargarProyectos() falló, su catch se traga el error y el cache queda
// vacío — antes eso hacía que TODAS las tareas salieran con proyecto: null sin que
// nadie se enterara. Pasándolo explícito, quien llama sabe qué mapa está usando.
//
// ⚠️ Ojo con .map(mapTarea): pasaría el índice como segundo argumento. Siempre
// .map(p => mapTarea(p, porId)).
function mapTarea(page, porId) {
  const relProyecto = page.properties['Proyecto']?.relation || [];
  const proyectoId = relProyecto[0]?.id || null;
  const hecho = page.properties['Hecho']?.checkbox || false;
  // "Fecha hecho" es la propiedad nueva (date). Las tareas cerradas ANTES de que
  // existiera no la tienen: para esas se usa last_edited_time como aproximación,
  // y se marca como tal. Nunca presentar una fecha aproximada como exacta.
  const fechaHecho = page.properties['Fecha hecho']?.date?.start || null;
  const aprox = hecho && !fechaHecho ? (page.last_edited_time || '').substring(0, 10) : null;
  return {
    id: page.id,
    titulo: page.properties['Siguiente acción']?.title?.[0]?.text?.content
      || page.properties['Siguiente acción']?.title?.[0]?.plain_text || '',
    contexto: page.properties['Contexto']?.select?.name || null,
    proyecto: proyectoId ? (porId?.get(proyectoId) || null) : null,
    dia_accion: page.properties['Dia acción']?.date?.start || null,
    fecha_limite: page.properties['Fecha límite']?.date?.start || null,
    me_gustaria_hoy: page.properties['Me gustaría hoy']?.checkbox || false,
    en_espera: page.properties['En espera']?.date?.start || null,
    hecho,
    fecha_hecho: fechaHecho,
    fecha_hecho_aprox: aprox || undefined
  };
}

// ─── Cache de tareas pendientes ───────────────────────────────────────────────
// Se lee la lista completa una vez y se puntúa en memoria. TTL corto porque en un
// mismo turno el modelo puede encadenar varias búsquedas, y se precarga en
// paralelo con Claude (igual que la base P.A.R.A), así que en la práctica el
// matching no cuesta ni una llamada HTTP.
let tareasCache = { ts: 0, lista: [] };
const TAREAS_TTL = 60 * 1000;

async function cargarTareasPendientes(forzar = false) {
  if (!forzar && Date.now() - tareasCache.ts < TAREAS_TTL && tareasCache.lista.length) {
    return tareasCache.lista;
  }
  try {
    const { porId } = await cargarProyectos();
    const paginas = await queryTodas({
      database_id: NOTION_DB_ID,
      filter: { property: 'Hecho', checkbox: { equals: false } },
      sorts: [{ property: 'Dia acción', direction: 'ascending' }]
    });
    tareasCache = { ts: Date.now(), lista: paginas.map(p => mapTarea(p, porId)) };
  } catch (e) {
    console.error('⚠️ cargarTareasPendientes:', e.message);
  }
  return tareasCache.lista;
}

// Invalidar el cache después de escribir, o la siguiente consulta del mismo turno
// devuelve la tarea que se acaba de marcar hecha.
function invalidarTareas() { tareasCache = { ts: 0, lista: [] }; }

// ─── Esquema de la base ───────────────────────────────────────────────────────
// "Fecha hecho" es una propiedad que Lucas agrega a mano en Notion. Si el código
// la escribiera o la filtrara sin que exista, la API devuelve 400 y marcar tareas
// como hechas se rompe por completo. Se detecta una vez y se degrada: sin la
// propiedad el bot sigue andando igual, solo que las fechas de cierre salen
// aproximadas por last_edited_time.
// El resultado positivo se cachea para siempre (una propiedad no desaparece), pero
// el negativo se reintenta cada 5 min: Lucas la va a agregar con el bot corriendo,
// y un "no existe" cacheado a perpetuidad lo obligaría a redeployar para nada.
let esquemaCache = null;
const ESQUEMA_TTL_NEGATIVO = 5 * 60 * 1000;

async function esquemaTareas() {
  if (esquemaCache?.tieneFechaHecho) return esquemaCache;
  if (esquemaCache && Date.now() - esquemaCache.ts < ESQUEMA_TTL_NEGATIVO) return esquemaCache;
  try {
    const db = await notion.databases.retrieve({ database_id: NOTION_DB_ID });
    const tieneFechaHecho = db.properties?.['Fecha hecho']?.type === 'date';
    if (tieneFechaHecho && !esquemaCache?.tieneFechaHecho) console.log('✅ Propiedad "Fecha hecho" detectada.');
    if (!tieneFechaHecho) {
      console.warn('⚠️ La base de tareas no tiene la propiedad "Fecha hecho" (date). Las fechas de cierre van a salir aproximadas.');
    }
    esquemaCache = { tieneFechaHecho, ts: Date.now() };
  } catch (e) {
    console.error('⚠️ esquemaTareas:', e.message);
    esquemaCache = { tieneFechaHecho: false, ts: Date.now() };
  }
  return esquemaCache;
}

// Trae las tareas HECHAS de los últimos `dias`, cacheadas por ventana. El cache
// existe sobre todo por la guardia anti-duplicado, que consulta la ventana corta
// en cada tarea que se crea.
const hechasCache = new Map();   // dias -> { ts, lista }
const HECHAS_TTL = 5 * 60 * 1000;

async function cargarTareasHechas(dias = 90) {
  const cacheado = hechasCache.get(dias);
  if (cacheado && Date.now() - cacheado.ts < HECHAS_TTL) return cacheado.lista;
  const desde = sumarDiasISO(fechaISO(), -dias);
  const [{ porId }, { tieneFechaHecho }] = await Promise.all([cargarProyectos(), esquemaTareas()]);

  // Con la propiedad: filtra por "Fecha hecho", y deja entrar por last_edited_time
  // a las que se cerraron antes de que existiera. Sin la propiedad: solo por
  // last_edited_time (filtrar por una propiedad inexistente sería un 400).
  const ventana = tieneFechaHecho
    ? { or: [
        { property: 'Fecha hecho', date: { on_or_after: desde } },
        { and: [
          { property: 'Fecha hecho', date: { is_empty: true } },
          { timestamp: 'last_edited_time', last_edited_time: { on_or_after: desde } }
        ]}
      ]}
    : { timestamp: 'last_edited_time', last_edited_time: { on_or_after: desde } };

  const paginas = await queryTodas({
    database_id: NOTION_DB_ID,
    filter: { and: [{ property: 'Hecho', checkbox: { equals: true } }, ventana] }
  });
  const lista = paginas.map(p => mapTarea(p, porId));
  hechasCache.set(dias, { ts: Date.now(), lista });
  return lista;
}

// Marca una página como hecha, completando "Fecha hecho" si la propiedad existe.
async function marcarPaginaHecha(pageId) {
  const { tieneFechaHecho } = await esquemaTareas();
  const properties = { 'Hecho': { checkbox: true } };
  if (tieneFechaHecho) properties['Fecha hecho'] = { date: { start: fechaISO() } };
  await notion.pages.update({ page_id: pageId, properties });
  invalidarTareas();
  hechasCache.clear();   // la tarea que se acaba de cerrar tiene que aparecer ya
}

// Puntúa un universo de tareas contra un texto y decide si hay un ganador claro.
// Función pura: no toca la red, así que se puede testear con fixtures.
//
// inequivoco = se puede ejecutar SIN preguntarle a Lucas. Es la guarda que
// faltaba: o hay una sola candidata, o la primera es un match fuerte Y le saca el
// doble a la segunda. Cualquier otra cosa vuelve como candidatos a confirmar.
function elegirCandidatos(universo, busqueda, hoy, limite = 5) {
  const puntuados = universo
    .map(t => ({ ...t, score: puntuarTarea(t, busqueda, hoy) }))
    .filter(t => t.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limite);

  const inequivoco = puntuados.length === 1
    || (puntuados.length > 1 && puntuados[0].score >= 10 && puntuados[0].score >= puntuados[1].score * 2);

  return { candidatos: puntuados, inequivoco };
}

// Busca tareas por texto. incluir_hechas: 'no' (default) | 'ambas' | 'solo'
async function buscarTareas(busqueda, { incluir_hechas = 'no', limite = 5 } = {}) {
  let universo = [];
  if (incluir_hechas !== 'solo') universo = universo.concat(await cargarTareasPendientes());
  if (incluir_hechas !== 'no') universo = universo.concat(await cargarTareasHechas());
  return elegirCandidatos(universo, busqueda, fechaISO(), limite);
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
- VER LO YA HECHO: podés consultar las tareas que Lucas ya cerró y cuándo las cerró (filtro "hechas" o incluir_hechas). Si te pregunta "¿esto ya lo hice?", buscá en las hechas y respondé con la fecha.
- Calendario Google: CREAR, CONSULTAR y BORRAR eventos.
- Proyectos (base P.A.R.A): CREAR proyectos nuevos, LISTARLOS con sus tareas abiertas, VINCULAR tareas y COMPLETARLOS cuando terminan.
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
- Los proyectos viven en la base P.A.R.A. Usá consultar_proyectos para ver los reales (te dice cuántas tareas abiertas tiene cada uno).
- Si Lucas pide crear un proyecto nuevo, usá crear_proyecto. Después podés vincular tareas con el campo "proyecto" al crear/editar.
- Si al crear una tarea mencionás un proyecto que no existe, avisale a Lucas y ofrecé crearlo.
- Un proyecto vive hasta que se completa. Cuando Lucas cierra la última tarea de un proyecto, ofrecéle darlo por completado con completar_proyecto.

REGLAS IMPORTANTES:
1. Reescribí las tareas como acciones físicas concretas (verbo + objeto).
2. Inferí el contexto y proyecto más probable según el contenido.
3. FECHA + HORA EXACTA: cuando Lucas da fecha Y hora concretas, creá DOS cosas: el evento en Calendar Y la tarea en Notion (para relevar la info). Si da solo fecha (sin hora) o nada → solo tarea en Notion.
4. DESPUÉS DE CREAR un evento o una tarea con fecha, mostrale a Lucas TODO lo que tiene ese día (eventos del calendario + tareas), numerado. Para eso consultá calendario y tareas de esa fecha.
5. NUMERÁ SIEMPRE las listas de tareas y eventos (1, 2, 3...). Así Lucas puede pedir cambios diciendo "el 2" o "borrá el 3".
6. CONFIRMACIÓN ANTES DE EDITAR/BORRAR: para editar, borrar o comentar, primero buscá; mostrale a Lucas el título exacto que encontraste y PEDÍ CONFIRMACIÓN antes de ejecutar. Las herramientas de editar/borrar/comentar, cuando las llamás solo con "busqueda", te devuelven candidatos SIN ejecutar nada. Recién cuando Lucas confirma, llamalas de nuevo pasando el "id" del candidato elegido. Ej: pide "modificá la tasación de fran" y la tarea real es "Tasación departamento Franco" → preguntá "¿Te referís a 'Tasación departamento Franco'?" antes de tocar.
7. CORRECCIÓN DE PALABRAS: si una palabra parece un error de tipeo o de transcripción de audio (no existe en español o no tiene sentido en el contexto), preguntá "¿Quisiste decir X?" antes de actuar, en vez de adivinar.
8. COMENTARIOS/INFORME: cuando Lucas quiera dejar el informe o una nota de una tarea, usá comentar_tarea (agrega un comentario nativo en Notion). Típicamente: comentar el informe y recién después marcar la tarea como hecha.
9. "YA HICE X": llamá a buscar_y_marcar_hecha con "busquedas". Si hay una sola coincidencia clara la marca sola. Si te devuelve requiere_confirmacion con varios candidatos, mostráselos NUMERADOS, preguntale cuál era, y volvé a llamarla con el "id" elegido en "ids". NUNCA elijas vos por descarte: marcar la tarea equivocada le borra algo real de la lista.
9b. "¿ESTO YA LO HICE?": consultá con filtro "hechas" o incluir_hechas:"ambas" y respondé con la fecha. Si la respuesta viene con fechas_aproximadas, decí "aprox." — esas fechas salen de la última edición de la página, no de cuándo la cerró de verdad.
9c. POSIBLE DUPLICADO: si crear_tarea_notion te devuelve posible_duplicado, no la crees. Decile a Lucas que esa tarea ya la cerró (con la fecha) y preguntale si igual la quiere. Solo si dice que sí, volvé a llamarla con crear_igual: true.
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
15. UBICACIÓN: lo que Lucas indique con "dónde", "en", "lugar" o una dirección va al campo "ubicacion" del evento (no a la descripción).
16. CIERRE DEL DÍA: a la noche el sistema te manda un turno automático con las tareas del día numeradas y sus ids. Cuando Lucas conteste ("hice la 1 y la 3", "la 2 pasala a mañana", "en la 1 anotá que..."), resolvé los números contra ESA lista y usá los ids exactos en "ids". Si por lo que sea perdiste la lista, NO adivines: volvé a consultar las tareas de hoy, mostrásela numerada de nuevo y pedile que confirme.
17. ORDEN AL CERRAR UNA TAREA: si Lucas deja un informe, comentá PRIMERO y marcá hecha DESPUÉS. Una vez marcada, la tarea sale de las listas por default y encontrarla para comentarla cuesta más.`;
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
        en_espera: { type: 'string', description: 'Fecha YYYY-MM-DD hasta la que queda en espera (es un campo de tipo fecha). Opcional.' },
        crear_igual: { type: 'boolean', description: 'Solo si la herramienta ya te avisó que es un posible duplicado y Lucas confirmó que igual la quiere. No lo pases la primera vez.' }
      },
      required: ['titulo']
    }
  },
  {
    name: 'buscar_y_marcar_hecha',
    description: 'Marca tareas como hechas. Si ya sabés el id exacto (porque se lo mostraste a Lucas numerado y él eligió, o porque venís de una confirmación) pasalo en "ids". Si no, pasá "busquedas": la herramienta puntúa y solo marca sola cuando hay una única coincidencia clara; si hay más de una candidata te las devuelve para que Lucas confirme. NUNCA inventes cuál era.',
    input_schema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'IDs exactos de tareas a marcar hechas. Usalo cuando Lucas eligió de una lista numerada o confirmó un candidato.'
        },
        busquedas: {
          type: 'array',
          items: { type: 'string' },
          description: 'Palabras clave para buscar cada tarea. Incluí nombres propios y palabras específicas.'
        }
      },
      required: []
    }
  },
  {
    name: 'consultar_tareas',
    description: 'Consulta tareas en Notion. Por default trae solo las PENDIENTES. Para ver lo ya cerrado usá filtro "hechas" (qué cerró Lucas en un rango) o el parámetro incluir_hechas.',
    input_schema: {
      type: 'object',
      properties: {
        filtro: {
          type: 'string',
          enum: ['hoy', 'mañana', 'semana', 'todas', 'en_espera', 'proyecto', 'trabajo', 'personal', 'fecha', 'hechas'],
          description: 'Qué tareas traer. "trabajo" = solo contextos con T. "personal" = solo contextos sin T. "proyecto" = de un proyecto. "fecha" = de un día puntual (usar campo fecha). "hechas" = las que Lucas ya cerró (usar fecha_desde/fecha_hasta; default últimos 7 días).'
        },
        proyecto: { type: 'string', description: 'Nombre del proyecto si filtro es "proyecto"' },
        fecha: { type: 'string', description: 'Fecha YYYY-MM-DD si filtro es "fecha"' },
        fecha_desde: { type: 'string', description: 'Inicio del rango YYYY-MM-DD (para filtro "hechas")' },
        fecha_hasta: { type: 'string', description: 'Fin del rango YYYY-MM-DD (para filtro "hechas")' },
        incluir_hechas: {
          type: 'string',
          enum: ['no', 'ambas', 'solo'],
          description: 'Default "no" (solo pendientes). "ambas" para ver pendientes y cerradas juntas, "solo" para ver únicamente las cerradas.'
        }
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
    description: 'Lista los proyectos de la base P.A.R.A con cuántas tareas abiertas tiene cada uno (para vincular tareas, ver cuáles hay, o detectar cuáles quedaron sin pendientes).',
    input_schema: {
      type: 'object',
      properties: {
        solo_activos: { type: 'boolean', description: 'true para traer solo proyectos activos' }
      },
      required: []
    }
  },
  {
    name: 'completar_proyecto',
    description: 'Marca un proyecto como Completado. Si todavía le quedan tareas abiertas NO lo cierra: te las devuelve para que Lucas decida si las cierra primero o si igual lo da por terminado.',
    input_schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'Nombre del proyecto a completar' },
        forzar: { type: 'boolean', description: 'true para cerrarlo aunque tenga tareas abiertas. Solo después de que Lucas lo confirme.' }
      },
      required: ['nombre']
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
    // ⚠️ El ttl DEBE coincidir con el del bloque estable del system: la API rechaza
    // con 400 un bloque ttl='1h' que venga después de uno ttl='5m'.
    cache_control: { type: 'ephemeral', ttl: '1h' }
  }
];

// ─── Implementación de herramientas ───────────────────────────────────────────

async function tool_crear_tarea_notion(input) {
  try {
    // Guardia anti-duplicado: si esto ya se hizo hace poco, avisar antes de crear.
    // Pasa seguido con el flujo de voz ("mandale los planos a Julia") cuando la
    // tarea ya se cerró y Lucas no se acuerda.
    if (!input.crear_igual) {
      const recientes = await cargarTareasHechas(7);
      const hoy = fechaISO();
      const yaHecha = recientes
        .map(t => ({ t, score: puntuarTarea(t, input.titulo, hoy) }))
        .sort((a, b) => b.score - a.score)[0];
      if (yaHecha && yaHecha.score >= 10) {
        return {
          ok: false, posible_duplicado: true,
          ya_hecha: {
            titulo: yaHecha.t.titulo,
            fecha: yaHecha.t.fecha_hecho || yaHecha.t.fecha_hecho_aprox || null,
            fecha_aproximada: !yaHecha.t.fecha_hecho || undefined
          },
          instruccion: 'Esta tarea parece ser una que Lucas YA cerró hace poco. Decíselo con la fecha (aclarando si es aproximada) y preguntale si igual quiere crearla. Si dice que sí, volvé a llamar crear_tarea_notion con crear_igual: true.'
        };
      }
    }

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
    invalidarTareas();
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

// Marca tareas como hechas. Dos caminos:
//   ids       → marca directo (ya confirmado, o elegido de una lista numerada)
//   busquedas → puntúa y SOLO marca si el ganador es inequívoco; si no, devuelve
//               candidatos para que Lucas confirme.
//
// El comportamiento viejo era: partir el texto en palabras, hacer una query por
// cada una, y quedarse con el PRIMER resultado que devolviera Notion sin mostrar
// nada. Con tres tareas que dijeran "Franco", marcaba cualquiera. Era el único
// camino de escritura destructiva del bot que no pedía confirmación.
async function tool_buscar_y_marcar_hecha(input) {
  const resultados = [];

  for (const id of input.ids || []) {
    try {
      const page = await notion.pages.retrieve({ page_id: id });
      const titulo = page.properties?.['Siguiente acción']?.title?.[0]?.plain_text || '';
      if (page.properties?.['Hecho']?.checkbox) {
        resultados.push({ id, titulo, ok: true, ya_estaba_hecha: true });
        continue;
      }
      await marcarPaginaHecha(id);
      await guardarHistorial(`Marcó como hecha: "${titulo}"`, null);
      console.log('✅ Marcada hecha:', titulo);
      resultados.push({ id, titulo, ok: true });
    } catch (e) {
      resultados.push({ id, ok: false, error: e.message });
    }
  }

  for (const busqueda of input.busquedas || []) {
    try {
      const { candidatos, inequivoco } = await buscarTareas(busqueda);
      if (!candidatos.length) {
        resultados.push({ busqueda, ok: false, mensaje: 'No encontré ninguna tarea pendiente que coincida' });
        continue;
      }
      if (!inequivoco) {
        resultados.push({
          busqueda, ok: false, requiere_confirmacion: true,
          candidatos: candidatos.map(c => ({ id: c.id, titulo: c.titulo, dia_accion: c.dia_accion, proyecto: c.proyecto })),
          instruccion: 'Hay más de una tarea que puede ser. Mostrale las opciones NUMERADAS a Lucas, preguntale cuál, y volvé a llamar buscar_y_marcar_hecha pasando el "id" elegido en el campo "ids". No adivines.'
        });
        continue;
      }
      const elegida = candidatos[0];
      await marcarPaginaHecha(elegida.id);
      await guardarHistorial(`Marcó como hecha: "${elegida.titulo}"`, null);
      console.log('✅ Marcada hecha:', elegida.titulo);
      resultados.push({ busqueda, id: elegida.id, titulo: elegida.titulo, ok: true });
    } catch (e) {
      resultados.push({ busqueda, ok: false, error: e.message });
    }
  }

  if (!resultados.length) return { ok: false, error: 'Pasá al menos "ids" o "busquedas".' };
  return resultados;
}

// Contextos GTD. T = trabajo, sin T = personal. Una sola definición: antes esta
// lista estaba escrita a mano en tres lugares distintos del archivo.
const CONTEXTOS_TRABAJO = ['T ROCA', 'T Ordenador', 'T < 5 min', 'T algún día/ a lo mejor', 'T Leer/ Revisar', 'T Tarea manual oficina', 'T Tarea fuera oficina'];
const CONTEXTOS_PERSONALES = ['ROCA', 'Ordenador', '< 5 min', 'algún día/ a lo mejor', 'Tarea manual casa', 'Energía baja', 'Tarea fuera de casa', 'Leer/Revisar'];

async function tool_consultar_tareas(input) {
  try {
    const [{ porId }, { tieneFechaHecho }] = await Promise.all([cargarProyectos(), esquemaTareas()]);
    const hoy = fechaISO();
    const incluir = input.incluir_hechas || (input.filtro === 'hechas' ? 'solo' : 'no');

    // Filtro base según qué estado de tarea se quiere ver.
    const porEstado = incluir === 'ambas' ? []
      : [{ property: 'Hecho', checkbox: { equals: incluir === 'solo' } }];

    const sorts = [{ property: 'Dia acción', direction: 'ascending' }];
    const traer = async (extra) => {
      const cond = [...porEstado, ...extra];
      const paginas = await queryTodas({
        database_id: NOTION_DB_ID,
        ...(cond.length ? { filter: cond.length === 1 ? cond[0] : { and: cond } } : {}),
        sorts
      });
      return paginas.map(p => mapTarea(p, porId));
    };

    // "hechas": qué cerré en un rango. Es la consulta que antes era imposible —
    // el filtro Hecho=false estaba en las 11 queries sin excepción.
    if (input.filtro === 'hechas') {
      const desde = input.fecha_desde || sumarDiasISO(hoy, -7);
      const hasta = input.fecha_hasta || hoy;
      let tareas;
      if (tieneFechaHecho) {
        tareas = await traer([
          { property: 'Fecha hecho', date: { on_or_after: desde } },
          { property: 'Fecha hecho', date: { on_or_before: hasta } }
        ]);
      } else {
        // Sin la propiedad solo queda last_edited_time, que es aproximado: se
        // declara como tal en la respuesta y no se disfraza de dato exacto.
        tareas = await traer([
          { timestamp: 'last_edited_time', last_edited_time: { on_or_after: desde } }
        ]);
        tareas = tareas.filter(t => (t.fecha_hecho || t.fecha_hecho_aprox || '') <= hasta);
      }
      return {
        filtro: 'hechas', desde, hasta, cantidad: tareas.length, tareas,
        fechas_aproximadas: !tieneFechaHecho || undefined,
        nota: tieneFechaHecho ? undefined : 'La base todavía no tiene la propiedad "Fecha hecho": estas fechas son aproximadas (última edición de la página). Decíselo a Lucas así, no las presentes como exactas.'
      };
    }

    let tareas = [];

    if (input.filtro === 'fecha') {
      tareas = await traer([{ property: 'Dia acción', date: { equals: input.fecha || hoy } }]);
    } else if (input.filtro === 'proyecto') {
      const p = await buscarProyectoId(input.proyecto);
      if (!p) return { filtro: 'proyecto', error: `No encontré el proyecto "${input.proyecto}"`, cantidad: 0, tareas: [] };
      tareas = await traer([{ property: 'Proyecto', relation: { contains: p.id } }]);
      return { filtro: 'proyecto', proyecto: p.nombre, cantidad: tareas.length, tareas };
    } else if (input.filtro === 'hoy') {
      tareas = await traer([{ or: [
        { property: 'Me gustaría hoy', checkbox: { equals: true } },
        { property: 'Dia acción', date: { equals: hoy } }
      ]}]);
    } else if (input.filtro === 'mañana') {
      // sumarDiasISO ancla al mediodía de Buenos Aires. El setDate(+1) de antes no
      // anclaba: entre las 21:00 y la medianoche "mañana" resolvía a pasado mañana,
      // justo en la franja en la que corre el cierre del día.
      tareas = await traer([{ property: 'Dia acción', date: { equals: sumarDiasISO(hoy, 1) } }]);
    } else if (input.filtro === 'semana') {
      tareas = await traer([
        { property: 'Dia acción', date: { on_or_after: hoy } },
        { property: 'Dia acción', date: { on_or_before: sumarDiasISO(hoy, 7) } }
      ]);
    } else if (input.filtro === 'en_espera') {
      tareas = await traer([{ property: 'En espera', date: { is_not_empty: true } }]);
    } else if (input.filtro === 'trabajo') {
      tareas = await traer([{ or: CONTEXTOS_TRABAJO.map(c => ({ property: 'Contexto', select: { equals: c } })) }]);
    } else if (input.filtro === 'personal') {
      tareas = await traer([{ or: [
        { property: 'Contexto', select: { is_empty: true } },
        ...CONTEXTOS_PERSONALES.map(c => ({ property: 'Contexto', select: { equals: c } }))
      ]}]);
    } else {
      // "todas" = sin filtro de contexto. Antes se filtraba por una whitelist de los
      // 15 contextos conocidos, así que cualquier tarea con un contexto nuevo (o
      // renombrado en Notion) desaparecía de "todas" sin aviso.
      tareas = await traer([]);
    }

    return { filtro: input.filtro, incluir_hechas: incluir, cantidad: tareas.length, tareas };
  } catch (e) {
    return { error: e.message };
  }
}

// Candidatos para las tools que piden confirmación (editar / eliminar / comentar).
// Antes hacía una query HTTP por palabra hasta juntar 5; ahora sale del cache de
// pendientes con scoring, sin llamadas extra.
async function buscarTareasCandidatas(busqueda, limite = 5) {
  const { candidatos } = await buscarTareas(busqueda, { limite });
  return candidatos.map(c => ({
    id: c.id, titulo: c.titulo, dia_accion: c.dia_accion, proyecto: c.proyecto, contexto: c.contexto
  }));
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
    invalidarTareas();
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
      // end.date es EXCLUSIVO en la API de Calendar: un evento del 9 al 9 dura
      // cero y Google lo muestra mal o no lo muestra. Un evento de un día entero
      // va del 9 al 10.
      eventBody.start = { date: input.fecha };
      eventBody.end = { date: sumarDiasISO(input.fecha, 1) };
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

    // Escapar la query: en el lenguaje de búsqueda de Drive los literales van
    // entre comillas simples, así que un apóstrofo ("Franco's", "O'Brien") cerraba
    // el literal y la llamada moría con un 400.
    const q = String(input.query || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    let queryParts = [`(fullText contains '${q}' or name contains '${q}')`];

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
      invalidarTareas();
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

    // Cuántas tareas abiertas tiene cada uno: es lo que permite decir "este quedó
    // sin nada pendiente, ¿lo cerramos?".
    const pendientes = await cargarTareasPendientes();
    const abiertasPorNombre = new Map();
    for (const t of pendientes) {
      if (t.proyecto) abiertasPorNombre.set(t.proyecto, (abiertasPorNombre.get(t.proyecto) || 0) + 1);
    }

    return {
      cantidad: proyectos.length,
      proyectos: proyectos.map(p => ({
        nombre: p.nombre, estado: p.estado, tareas_abiertas: abiertasPorNombre.get(p.nombre) || 0
      }))
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Cierra un proyecto. No lo cierra a ciegas: si le quedan tareas abiertas las
// muestra y espera confirmación, porque cerrar un proyecto con pendientes las
// deja huérfanas y fuera de vista.
async function tool_completar_proyecto(input) {
  try {
    const p = await buscarProyectoId(input.nombre);
    if (!p) return { ok: false, error: `No encontré el proyecto "${input.nombre}"` };

    const pendientes = (await cargarTareasPendientes()).filter(t => t.proyecto === p.nombre);
    if (pendientes.length && !input.forzar) {
      return {
        ok: false, requiere_confirmacion: true, proyecto: p.nombre,
        tareas_abiertas: pendientes.map(t => ({ id: t.id, titulo: t.titulo, dia_accion: t.dia_accion })),
        instruccion: `El proyecto "${p.nombre}" todavía tiene ${pendientes.length} tarea(s) abierta(s). Mostrálas NUMERADAS y preguntale a Lucas si las cierra primero, o si igual quiere dar el proyecto por completado. Para cerrarlo igual, volvé a llamar completar_proyecto con forzar: true.`
      };
    }

    await notion.pages.update({
      page_id: p.id,
      properties: { 'Estado Proyecto': { select: { name: 'Completado' } } }
    });
    await cargarProyectos(true);
    await guardarHistorial(`Completó proyecto: "${p.nombre}"`, null);
    console.log('✅ Proyecto completado:', p.nombre);
    return { ok: true, proyecto: p.nombre, tareas_abiertas_al_cerrar: pendientes.length };
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
    case 'completar_proyecto':        return await tool_completar_proyecto(input);
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
      // ⚠️ El ttl tiene que coincidir con el del cache_control de la última tool
      // (ver TOOLS): un bloque de 1h después de uno de 5m devuelve 400.
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

// Este bot tiene acceso de ESCRITURA al Notion y al Calendar de Lucas, así que
// falla cerrado: sin whitelist configurada no atiende a nadie. Antes hacía lo
// contrario (sin whitelist dejaba pasar a cualquiera) "para la fase de setup", y
// esa fase se quedó: el servicio estuvo abierto en producción. El user id igual
// se puede descubrir por los logs, que es para lo que servía.
function autorizado(message) {
  const id = String(message.from?.id || '');
  if (!ALLOWED_USER_IDS.length) {
    console.warn(`⛔ TELEGRAM_ALLOWED_USER_IDS está vacío: rechazando a todos. El user id de quien escribió es ${id}.`);
    return false;
  }
  return ALLOWED_USER_IDS.includes(id);
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
  // Las pendientes también, que es de donde sale el matching: cuando una tool
  // tenga que buscar una tarea, la lista ya va a estar en memoria y no cuesta
  // ninguna llamada HTTP.
  void cargarTareasPendientes().catch(() => {});

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

// ─── Cierre del día y plan de la mañana ───────────────────────────────────────
// Hasta acá el bot era 100% reactivo: solo contestaba webhooks de Telegram. Estos
// dos endpoints los dispara Cloud Scheduler y son los únicos lugares donde el bot
// escribe primero.
//
// ⚠️ El servicio es público (el webhook de Telegram lo obliga), así que estos
// endpoints se protegen con un secret propio, igual que el webhook.
const CRON_SECRET = process.env.CRON_SECRET || '';
// En un chat privado de Telegram el chat_id es igual al user_id.
//
// ⚠️ VA COMO NÚMERO, no como string. La memoria de conversación es un Map
// indexado por chatId, y manejarUpdate usa `message.chat.id`, que Telegram manda
// como número. Con "5029988668" (string) el cierre del día escribiría en un
// bucket de memoria distinto al del chat real: cuando Lucas contestara "hice la 1
// y la 3", el modelo no tendría ni idea de qué lista le está hablando.
const CHAT_ID_CRON = Number(process.env.TELEGRAM_CHAT_ID || ALLOWED_USER_IDS[0]) || null;

// Un reintento de Scheduler no puede mandar el cierre dos veces.
// ⚠️ Vive en memoria, igual que el dedupe de updates: sirve con UNA instancia.
const cronEnviado = new Map();   // 'cierre-dia' -> 'YYYY-MM-DD'

function cronAutorizado(req) {
  if (!CRON_SECRET) {
    console.warn('⛔ CRON_SECRET no está seteado: los endpoints de cron quedan cerrados.');
    return false;
  }
  return req.get('X-Cron-Secret') === CRON_SECRET;
}

// Junta lo que el bot necesita saber para preguntarle a Lucas cómo le fue.
async function datosDelCierre() {
  const hoy = fechaISO();
  const [pendientes, cerradas] = await Promise.all([
    tool_consultar_tareas({ filtro: 'hoy' }),
    tool_consultar_tareas({ filtro: 'hechas', fecha_desde: hoy, fecha_hasta: hoy })
  ]);
  // Orden determinista: si la memoria se perdiera y hubiera que regenerar la
  // lista, tiene que salir en el mismo orden. Por día de acción y después por
  // título, que no depende de en qué orden devuelva Notion.
  const tareas = (pendientes.tareas || []).slice().sort((a, b) =>
    (a.dia_accion || '9999').localeCompare(b.dia_accion || '9999') || a.titulo.localeCompare(b.titulo)
  );
  return { hoy, tareas, cerradas_hoy: cerradas.cantidad || 0, fechas_aproximadas: !!cerradas.fechas_aproximadas };
}

app.post('/cron/cierre-dia', async (req, res) => {
  if (!cronAutorizado(req)) return res.status(403).send('');
  res.status(200).send('');   // Scheduler no espera; el trabajo sigue en este request

  try {
    const hoy = fechaISO();
    if (cronEnviado.get('cierre-dia') === hoy) {
      console.log('🔁 Cierre del día ya enviado hoy, ignoro el reintento');
      return;
    }
    if (!CHAT_ID_CRON) {
      console.error('❌ Cierre del día: no hay TELEGRAM_CHAT_ID ni whitelist para saber a quién escribirle');
      return;
    }

    const datos = await datosDelCierre();

    // Sin pendientes no se manda nada. Un mensaje diario que dice "no tenías nada"
    // entrena a ignorar el mensaje, y entonces tampoco se lee el que sí importa.
    // ⚠️ Sin pendientes NO se marca el día como enviado. La guardia existe para
    // que un reintento no duplique un mensaje ya mandado; si no se mandó nada, no
    // hay nada que proteger. Marcarlo igual hacía que una corrida temprana (una
    // prueba a mano, por ejemplo) tapara la corrida real de las 21:00 aunque para
    // entonces Lucas ya hubiera cargado tareas.
    if (!datos.tareas.length) {
      console.log(`🌙 Cierre del día: sin pendientes (cerró ${datos.cerradas_hoy}), no mando nada`);
      return;
    }

    // Se compone pasando por Claude en vez de con una plantilla: así lo redacta
    // natural Y —lo importante— la lista con los ids queda en la memoria de la
    // conversación por el camino normal. Eso es lo que hace que después "hice la 1
    // y la 3" signifique algo.
    const lista = datos.tareas
      .map((t, i) => `${i + 1}. ${t.titulo}${t.proyecto ? ` [${t.proyecto}]` : ''} (id: ${t.id})`)
      .join('\n');

    const turno = `[CIERRE AUTOMÁTICO DEL DÍA — lo generó el sistema a la noche, no lo escribió Lucas]

Tareas del día que siguen SIN marcar (${datos.tareas.length}):
${lista}

Tareas que Lucas cerró hoy: ${datos.cerradas_hoy}

Escribile a Lucas un mensaje corto y directo preguntándole cómo le fue:
- Si cerró alguna hoy, arrancá reconociéndolo en una línea (ej. "Hoy cerraste 4.").
- Listá las pendientes NUMERADAS, con el mismo número y el mismo orden que arriba. NO muestres los ids.
- Cerrá invitándolo a decirte cuáles hizo y a dejarte el informe de alguna si quiere.
- Nada de saludos largos ni de motivación. Directo, como siempre.
- NO llames a ninguna herramienta todavía: esperá su respuesta. Los ids de arriba son para usarlos DESPUÉS, cuando él te diga cuáles hizo.`;

    const respuesta = await procesarConClaude(CHAT_ID_CRON, turno);
    await enviarTelegram(CHAT_ID_CRON, respuesta);
    cronEnviado.set('cierre-dia', hoy);
    console.log(`🌙 Cierre del día enviado: ${datos.tareas.length} pendientes, ${datos.cerradas_hoy} cerradas`);
    try { await compactarPendiente(CHAT_ID_CRON); } catch (e) { console.error('⚠️ compactar:', e.message); }
  } catch (e) {
    console.error('❌ Cierre del día:', e.message);
  }
});

app.post('/cron/plan-dia', async (req, res) => {
  if (!cronAutorizado(req)) return res.status(403).send('');
  res.status(200).send('');

  try {
    const hoy = fechaISO();
    if (cronEnviado.get('plan-dia') === hoy) return;
    if (!CHAT_ID_CRON) return;

    const respuesta = await procesarConClaude(CHAT_ID_CRON,
      '[PLAN AUTOMÁTICO DE LA MAÑANA — lo generó el sistema, no lo escribió Lucas]\n\n' +
      'Usá plan_del_dia y contale a Lucas cómo viene el día: eventos del calendario con su horario y tareas pendientes, todo numerado. Corto y directo. Si no hay nada de nada, decíselo en una línea.');
    await enviarTelegram(CHAT_ID_CRON, respuesta);
    cronEnviado.set('plan-dia', hoy);
    console.log('☀️ Plan de la mañana enviado');
    try { await compactarPendiente(CHAT_ID_CRON); } catch (e) { console.error('⚠️ compactar:', e.message); }
  } catch (e) {
    console.error('❌ Plan de la mañana:', e.message);
  }
});

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

// ─── Health check ─────────────────────────────────────────────────────────────
// Prueba de verdad contra las APIs en vez de mirar si existen las env vars. Antes
// reportaba calendar:✅ con solo tener tres variables seteadas, así que con el
// refresh token vencido el health seguía en verde y el bot estaba roto.
app.get('/health', async (req, res) => {
  const probar = async (fn) => {
    try { await fn(); return '✅'; } catch (e) { return `❌ ${e.message.substring(0, 80)}`; }
  };

  const [notionOk, calendarOk, esquema] = await Promise.all([
    probar(() => notion.databases.retrieve({ database_id: NOTION_DB_ID })),
    probar(async () => {
      const auth = getGoogleAuth();
      if (!auth) throw new Error('OAuth no configurado');
      await auth.getAccessToken();   // fuerza el refresh: acá se cae si venció
    }),
    esquemaTareas().catch(() => ({ tieneFechaHecho: false }))
  ]);

  res.json({
    status: 'running',
    version: '7.1.0',
    model: MODEL,
    effort: EFFORT,
    notion: notionOk,
    calendar: calendarOk,
    propiedad_fecha_hecho: esquema.tieneFechaHecho ? '✅' : '⚠️ falta (fechas de cierre aproximadas)',
    whitelist_usuarios: ALLOWED_USER_IDS.length || '⚠️ 0 — el bot no atiende a nadie',
    secret_webhook: WEBHOOK_SECRET ? '✅' : '(sin secret)',
    cron: CRON_SECRET && CHAT_ID_CRON ? '✅' : `⚠️ ${!CRON_SECRET ? 'falta CRON_SECRET' : 'falta TELEGRAM_CHAT_ID'}`
  });
});

// ─── Iniciar ──────────────────────────────────────────────────────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 8080;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Segundo Cerebro Bot v7.1 en puerto ${PORT}`);
    console.log(`🤖 Modelo: ${MODEL} (effort ${EFFORT})`);
    console.log(`📋 Notion: ${NOTION_DB_ID}`);
    console.log(`📅 Calendar: ${CALENDAR_ID}`);
    console.log(`📚 Historial: ${NOTION_HISTORIAL_ID}`);
    console.log(`📱 Telegram: ${TELEGRAM_TOKEN ? '✅' : '❌'}`);
    console.log(`🎙️ Groq: ${GROQ_API_KEY ? '✅' : '❌'}`);
    console.log(`🔐 Secret webhook: ${WEBHOOK_SECRET ? '✅' : '⚠️ sin secret'}`);
    console.log(`👥 Usuarios autorizados: ${ALLOWED_USER_IDS.length || '⚠️ NINGUNO — el bot no va a contestarle a nadie (setear TELEGRAM_ALLOWED_USER_IDS)'}`);
    console.log(`⏰ Cron (cierre del día): ${CRON_SECRET && CHAT_ID_CRON ? `✅ → chat ${CHAT_ID_CRON}` : `⚠️ ${!CRON_SECRET ? 'falta CRON_SECRET' : 'falta TELEGRAM_CHAT_ID'}`}`);

    // Warm-up: abrir TLS con Notion y Telegram y precargar la base P.A.R.A,
    // para que el primer mensaje real no pague los handshakes. Sin bloquear el boot.
    cargarProyectos()
      .then(c => console.log(`🔥 Warm-up Notion OK (${c.lista.length} proyectos)`))
      .catch(e => console.error('⚠️ Warm-up Notion:', e.message));
    warmupTelegram().then(d => console.log(`🔥 Warm-up Telegram ${d?.ok ? 'OK' : 'falló'}`)).catch(() => {});
  });
}

// manejarUpdate lo usa dev-polling.js. El resto se exporta para poder testear la
// lógica pura (matching, fechas) sin levantar el servidor ni pegarle a Notion.
module.exports = {
  manejarUpdate,
  normalizar, palabrasSignificativas, distancia, puntuarTarea,
  sumarDiasISO, sumarMinutos, elegirCandidatos,
  CHAT_ID_CRON   // exportado solo para que el test verifique que es número
};
