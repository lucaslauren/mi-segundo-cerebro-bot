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
const memoriaSession = new Map();   // chatId -> array de mensajes Anthropic
const resumenSession = new Map();   // chatId -> string (resumen de lo más viejo)
const KEEP_MSGS = 30;               // mensajes crudos recientes que mantenemos

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
async function compactarResumen(chatId, descartados) {
  if (!descartados.length) return;
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
function getGoogleAuth() {
  try {
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
    if (!clientId || !clientSecret || !refreshToken) return null;
    const auth = new google.auth.OAuth2(clientId, clientSecret);
    auth.setCredentials({ refresh_token: refreshToken });
    return auth;
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
function buildSystemPrompt(resumen) {
  const bloqueResumen = resumen
    ? `\n\nRESUMEN DE LA CONVERSACIÓN PREVIA (memoria de largo plazo, no la pierdas):\n${resumen}\n`
    : '';

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
   - Viajes, traslados, autos → colorId "11" (Transporte, rojo)${bloqueResumen}`;
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
        todo_el_dia: { type: 'boolean', description: 'true si es evento de todo el día' },
        colorId: { type: 'string', description: 'Color: 9=Laboral (azul), 5=Personal (amarillo), 4=Desarrollo personal (rosa), 11=Transporte (rojo)' }
      },
      required: ['titulo', 'fecha']
    }
  },
  {
    name: 'consultar_calendario',
    description: 'Consulta eventos del calendario de Lucas. Podés usar "periodo" (hoy/mañana/semana) o "fecha" para un día puntual.',
    input_schema: {
      type: 'object',
      properties: {
        periodo: {
          type: 'string',
          enum: ['hoy', 'mañana', 'semana'],
          description: 'Período a consultar (ignorado si pasás "fecha")'
        },
        fecha: { type: 'string', description: 'Fecha puntual YYYY-MM-DD (tiene prioridad sobre periodo)' }
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
    const auth = getGoogleAuth();
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
    const auth = getGoogleAuth();
    if (!auth) return { ok: false, error: 'Calendar no configurado' };
    const cal = google.calendar({ version: 'v3', auth });

    // Si viene "fecha" puntual, armamos el rango de ese día; si no, usamos el periodo.
    let timeMin, timeMax;
    if (input.fecha && /^\d{4}-\d{2}-\d{2}/.test(input.fecha)) {
      const d = input.fecha.substring(0, 10);
      timeMin = `${d}T00:00:00-03:00`;
      timeMax = `${d}T23:59:59-03:00`;
    } else {
      ({ timeMin, timeMax } = getBuenosAiresDateRange(input.periodo || 'hoy'));
    }
    console.log(`📅 Calendar query: ${input.fecha || input.periodo || 'hoy'} | ${timeMin} → ${timeMax} | calendarId=${CALENDAR_ID}`);

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
      periodo: input.fecha || input.periodo || 'hoy',
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
    const auth = getGoogleAuth();
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

async function tool_eliminar_evento_calendario(input) {
  try {
    const auth = getGoogleAuth();
    if (!auth) return { ok: false, error: 'Calendar no configurado' };
    const cal = google.calendar({ version: 'v3', auth });

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

  let respuestaFinal = null;
  let iteraciones = 0;
  const MAX_ITERACIONES = 8;

  while (iteraciones < MAX_ITERACIONES) {
    iteraciones++;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: buildSystemPrompt(obtenerResumen(chatId)),
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

  // Recorte seguro (sin tool_result huérfanos) + compactación de lo que sale.
  const { ventana, descartados } = recortarSeguro(mensajes);
  memoriaSession.set(chatId, ventana);
  if (descartados.length) {
    try { await compactarResumen(chatId, descartados); }
    catch (e) { console.error('⚠️ compactarResumen:', e.message); }
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

    // procesarConClaude agrega el mensaje del usuario y maneja la memoria.
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
