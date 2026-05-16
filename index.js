/**
 * SEGUNDO CEREBRO BOT v3.0
 * Secretario personal de Lucas Hernán Laurenzano
 *
 * Capacidades:
 * - Crear tareas en Notion con clasificación GTD
 * - Consultar tareas (hoy, mañana, semana, por proyecto)
 * - Marcar tareas como hechas
 * - Editar tareas existentes
 * - Crear/consultar/modificar eventos en Google Calendar
 * - Plan del día y plan semanal
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

// ─── Google Calendar (Service Account) ───────────────────────────────────────
function getCalendarClient() {
  try {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}';
    const credentials = JSON.parse(raw);
    if (!credentials.client_email) return null;
    // Sanitizar private_key — las variables de entorno convierten \n en \\n
    if (credentials.private_key) {
      credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
    }
    const auth = new google.auth.JWT(
      credentials.client_email,
      null,
      credentials.private_key,
      ['https://www.googleapis.com/auth/calendar']
    );
    return google.calendar({ version: 'v3', auth });
  } catch (e) {
    console.error('⚠️ Calendar no configurado:', e.message);
    return null;
  }
}

// ─── Helpers de fecha ─────────────────────────────────────────────────────────
function fechaHoy() {
  return new Date().toLocaleDateString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}

function fechaISO() {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires'
  });
}

function sumarHora(horaStr, horas) {
  const [h, m] = horaStr.split(':').map(Number);
  const d = new Date();
  d.setHours(h + horas, m, 0);
  return d.toTimeString().substring(0, 5);
}

// ─── System prompt ────────────────────────────────────────────────────────────
function buildSystemPrompt() {
  return `Sos el secretario personal IA de Lucas Hernán Laurenzano.
Lucas es CEO de DLP (Daniel Laurenzano Propiedades), co-fundador de Smart Developments SRL, y socio en Tuluka (gym). Vive en Buenos Aires con Julia y su hijo Vito.

TU ROL: Sos su cerebro externo. Manejás su sistema GTD en Notion y su calendario. Lucas no tiene que mirar Notion ni Calendar — vos le decís todo lo que necesita y ejecutás lo que pide.

FECHA ACTUAL: ${fechaHoy()}

═══ PROYECTOS ACTIVOS ═══
- SDVL | N3302 (Smart Developments - edificio N3302, Bahía Blanca)
- LAURENGROUP | Contabilidad
- DLP | Avances CUPULA
- SMART | CUPULA + MARIAN

═══ CONTEXTOS GTD ═══
Sin T = Personal | Con T = Trabajo
- ROCA / T ROCA → máximo impacto, bloque 1.5-2hs mañana temprano
- Ordenador / T Ordenador → requiere computadora
- < 5 min / T < 5 min → llamada o tarea rápida
- Tarea manual casa → física en casa
- Energía baja → poca concentración
- algún día/ a lo mejor / T algún día/ a lo mejor → sin urgencia
- Tarea fuera de casa → salir
- Leer/Revisar / T Leer/ Revisar → leer documento
- T Tarea manual oficina → física en oficina
- T Tarea fuera oficina → salir de oficina

═══ INTENCIONES ═══
Determiná la intención y devolvé JSON válido sin texto extra ni markdown.

1. CREAR_TAREA → nueva tarea
2. MARCAR_HECHA → completar tarea existente
3. CONSULTAR_TAREAS → qué tiene pendiente
4. EDITAR_TAREA → modificar tarea existente
5. CREAR_EVENTO → agendar en calendario
6. CONSULTAR_CALENDARIO → qué tiene en el calendario
7. MODIFICAR_EVENTO → cambiar evento
8. PLAN_DIA → resumen del día
9. PLAN_SEMANA → plan semanal
10. CONVERSACION → otro

═══ FORMATOS JSON ═══

CREAR_TAREA:
{"intencion":"CREAR_TAREA","tareas":[{"siguiente_accion":"verbo+objeto","contexto":"exacto de la lista","proyecto":"nombre exacto o null","en_espera":"Nombre re: tema o null","dia_accion":"YYYY-MM-DD o null","fecha_limite":"YYYY-MM-DD o null","me_gustaria_hoy":false,"dos_minutos":false}],"respuesta":"confirmación"}

MARCAR_HECHA:
{"intencion":"MARCAR_HECHA","busqueda":"palabras clave de la tarea","respuesta":"confirmación"}

CONSULTAR_TAREAS:
{"intencion":"CONSULTAR_TAREAS","filtro":"hoy|mañana|semana|proyecto|todas|en_espera","proyecto":"nombre o null","respuesta":"placeholder"}

EDITAR_TAREA:
{"intencion":"EDITAR_TAREA","busqueda":"palabras clave","cambios":{"siguiente_accion":null,"contexto":null,"dia_accion":null,"fecha_limite":null,"me_gustaria_hoy":null},"respuesta":"confirmación"}

CREAR_EVENTO:
{"intencion":"CREAR_EVENTO","evento":{"titulo":"nombre","fecha":"YYYY-MM-DD","hora_inicio":"HH:MM o null","hora_fin":"HH:MM o null","descripcion":null,"todo_el_dia":false},"respuesta":"confirmación"}

CONSULTAR_CALENDARIO:
{"intencion":"CONSULTAR_CALENDARIO","periodo":"hoy|mañana|semana","respuesta":"placeholder"}

MODIFICAR_EVENTO:
{"intencion":"MODIFICAR_EVENTO","busqueda":"palabras clave","cambios":{"titulo":null,"fecha":null,"hora_inicio":null,"hora_fin":null},"respuesta":"confirmación"}

PLAN_DIA:
{"intencion":"PLAN_DIA","respuesta":"placeholder"}

PLAN_SEMANA:
{"intencion":"PLAN_SEMANA","respuesta":"placeholder"}

CONVERSACION:
{"intencion":"CONVERSACION","respuesta":"respuesta útil como secretario"}`;
}

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'running', version: '3.0.0' });
});

// ─── Telegram: enviar mensaje ─────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

async function enviarMensajeTelegram(chatId, texto) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: texto,
        parse_mode: 'Markdown'
      })
    });
    const data = await response.json();
    if (!data.ok) console.error('❌ Telegram error:', data.description);
    else console.log('✅ Mensaje enviado a Telegram:', chatId);
  } catch (error) {
    console.error('❌ Error Telegram:', error.message);
  }
}

// ─── Telegram: transcribir audio con Groq Whisper ────────────────────────────
async function transcribirAudioTelegram(fileId) {
  try {
    // 1. Obtener URL del archivo de Telegram
    const fileRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
    const fileData = await fileRes.json();
    if (!fileData.ok) throw new Error('No se pudo obtener el archivo de Telegram');

    const filePath = fileData.result.file_path;
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;

    // 2. Descargar el audio
    const audioRes = await fetch(fileUrl);
    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

    // 3. Transcribir con Groq Whisper
    const formData = new FormData();
    const audioBlob = new Blob([audioBuffer], { type: 'audio/ogg' });
    formData.append('file', audioBlob, 'audio.ogg');
    formData.append('model', 'whisper-large-v3-turbo');
    formData.append('language', 'es');
    formData.append('response_format', 'json');

    const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: formData
    });

    const groqData = await groqRes.json();
    console.log('🎙️ Groq response:', JSON.stringify(groqData));

    return groqData.text || null;

  } catch (error) {
    console.error('❌ Error transcripción Groq:', error.message);
    return null;
  }
}

// ─── Webhook Telegram ─────────────────────────────────────────────────────────
app.post('/webhook/telegram', async (req, res) => {
  res.status(200).send(''); // Responder inmediatamente

  try {
    const update = req.body;
    const message = update.message || update.edited_message;
    if (!message) return;

    const chatId = message.chat.id;
    const userId = message.from.id;

    console.log('💬 Telegram update:', JSON.stringify(message, null, 2));

    let userText = null;

    // Texto normal
    if (message.text) {
      userText = message.text.trim();
    }
    // Audio / mensaje de voz
    else if (message.voice || message.audio) {
      // Intentar transcripción nativa de Telegram primero
      if (message.voice?.transcription) {
        userText = message.voice.transcription;
        console.log('📝 Transcripción nativa Telegram:', userText);
      } else {
        // Usar Google Speech-to-Text
        const fileId = message.voice?.file_id || message.audio?.file_id;
        if (fileId) {
          await enviarMensajeTelegram(chatId, '🎙️ _Transcribiendo..._');
          userText = await transcribirAudioTelegram(fileId);
          if (!userText) {
            await enviarMensajeTelegram(chatId, '❌ No pude transcribir el audio. Intentá escribir el mensaje.');
            return;
          }
          console.log('📝 Transcripción Google Speech:', userText);
          await enviarMensajeTelegram(chatId, `📝 _"${userText}"_`);
        } else {
          await enviarMensajeTelegram(chatId, '❌ No pude obtener el audio.');
          return;
        }
      }
    }
    // Otros tipos (fotos, documentos, etc.)
    else {
      await enviarMensajeTelegram(chatId, '⚠️ Solo proceso texto y audio. Mandame un mensaje de voz o escribí.');
      return;
    }

    if (!userText) return;

    console.log('💬 Lucas:', userText);

    // Procesar y responder
    procesarIntencion(userText)
      .then(resultado => {
        console.log('🎯 Intención:', resultado.intencion);
        return ejecutarIntencion(resultado);
      })
      .then(respuesta => {
        console.log('📤 Enviando respuesta, largo:', respuesta?.length);
        return enviarMensajeTelegram(chatId, respuesta);
      })
      .catch(async error => {
        console.error('❌ Error procesamiento:', error.message);
        await enviarMensajeTelegram(chatId, `❌ Error: ${error.message}`);
      });

  } catch (error) {
    console.error('❌ Error webhook Telegram:', error.message);
  }
});

// ─── Mantener webhook de Google Chat (por si acaso) ───────────────────────────
app.post('/webhook/google-chat', async (req, res) => {
  res.status(200).send('');
});

// ─── Procesar intención ───────────────────────────────────────────────────────
async function procesarIntencion(texto) {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2000,
    system: buildSystemPrompt(),
    messages: [{ role: 'user', content: `Mensaje de Lucas: "${texto}"` }]
  });

  const raw = response.content[0].text.trim();
  console.log('🤖 Claude:', raw);

  // Extraer solo el bloque JSON aunque venga con texto alrededor
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude no devolvió JSON válido');
  return JSON.parse(jsonMatch[0]);
}

// ─── Ejecutar intención ───────────────────────────────────────────────────────
async function ejecutarIntencion(resultado) {
  switch (resultado.intencion) {
    case 'CREAR_TAREA':         return await ejecutarCrearTarea(resultado);
    case 'MARCAR_HECHA':        return await ejecutarMarcarHecha(resultado);
    case 'CONSULTAR_TAREAS':    return await ejecutarConsultarTareas(resultado);
    case 'EDITAR_TAREA':        return await ejecutarEditarTarea(resultado);
    case 'CREAR_EVENTO':        return await ejecutarCrearEvento(resultado);
    case 'CONSULTAR_CALENDARIO':return await ejecutarConsultarCalendario(resultado);
    case 'MODIFICAR_EVENTO':    return await ejecutarModificarEvento(resultado);
    case 'PLAN_DIA':            return await ejecutarPlanDia();
    case 'PLAN_SEMANA':         return await ejecutarPlanSemana();
    case 'CONVERSACION':        return resultado.respuesta;
    default:                    return resultado.respuesta || '¿Podés ser más específico?';
  }
}

// ─── CREAR TAREA ──────────────────────────────────────────────────────────────
async function ejecutarCrearTarea(resultado) {
  const tareas = resultado.tareas || [];
  if (!tareas.length) return '❌ No pude identificar la tarea.';

  const creadas = [];
  for (const tarea of tareas) {
    const page = await guardarEnNotion(tarea);
    creadas.push({ tarea, id: page.id });
    console.log('✅ Notion:', page.id);
  }

  if (creadas.length === 1) {
    const t = creadas[0].tarea;
    let msg = `✅ *Guardado*\n📌 ${t.siguiente_accion}`;
    if (t.contexto)      msg += `\n🏷️ ${t.contexto}`;
    if (t.proyecto)      msg += `\n📁 ${t.proyecto}`;
    if (t.dia_accion)    msg += `\n📅 ${t.dia_accion}`;
    if (t.dos_minutos)   msg += `\n⚡ *Menos de 2 min — hacelo ahora*`;
    if (t.en_espera)     msg += `\n⏳ En espera: ${t.en_espera}`;
    return msg;
  }

  let msg = `✅ *${creadas.length} tareas guardadas*\n`;
  creadas.forEach((c, i) => {
    msg += `\n${i + 1}. ${c.tarea.siguiente_accion}`;
    if (c.tarea.contexto) msg += ` (${c.tarea.contexto})`;
  });
  return msg;
}

// ─── MARCAR HECHA ─────────────────────────────────────────────────────────────
async function ejecutarMarcarHecha(resultado) {
  const tareas = await buscarTareasPorTexto(resultado.busqueda);
  if (!tareas.length) return `❌ No encontré tarea con "${resultado.busqueda}". ¿Podés ser más específico?`;

  const tarea = tareas[0];
  await notion.pages.update({
    page_id: tarea.id,
    properties: { 'Hecho': { checkbox: true } }
  });

  console.log('✅ Marcada hecha:', tarea.titulo);
  return `✅ Listo — *"${tarea.titulo}"* marcada como hecha.`;
}

// ─── CONSULTAR TAREAS ─────────────────────────────────────────────────────────
async function ejecutarConsultarTareas(resultado) {
  const { filtro, proyecto } = resultado;
  const hoy = fechaISO();
  let tareas = [];
  let titulo = '';

  if (filtro === 'hoy') {
    tareas = await obtenerTareasFecha(hoy);
    titulo = `☀️ *Tareas para hoy*`;
  } else if (filtro === 'mañana') {
    const d = new Date(); d.setDate(d.getDate() + 1);
    const manana = d.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
    tareas = await obtenerTareasFecha(manana);
    titulo = `📅 *Tareas para mañana (${manana})*`;
  } else if (filtro === 'semana') {
    tareas = await obtenerTareasSemana();
    titulo = `📋 *Tareas esta semana*`;
  } else if (filtro === 'proyecto' && proyecto) {
    tareas = await obtenerTareasPorProyecto(proyecto);
    titulo = `📁 *${proyecto}*`;
  } else if (filtro === 'en_espera') {
    tareas = await obtenerTareasEnEspera();
    titulo = `⏳ *En espera*`;
  } else {
    tareas = await obtenerTareasPendientes();
    titulo = `📋 *Todas las pendientes*`;
  }

  if (!tareas.length) return `${titulo}\n\n_Nada pendiente._`;

  let msg = `${titulo} — ${tareas.length}\n`;
  tareas.forEach((t, i) => {
    msg += `\n${i + 1}. ${t.titulo}`;
    if (t.contexto)   msg += ` _(${t.contexto})_`;
    if (t.dia_accion) msg += ` — ${t.dia_accion}`;
    if (t.en_espera)  msg += ` ⏳`;
  });
  return msg;
}

// ─── EDITAR TAREA ─────────────────────────────────────────────────────────────
async function ejecutarEditarTarea(resultado) {
  const { busqueda, cambios } = resultado;
  const tareas = await buscarTareasPorTexto(busqueda);
  if (!tareas.length) return `❌ No encontré tarea con "${busqueda}".`;

  const tarea = tareas[0];
  const properties = {};

  if (cambios.siguiente_accion) properties['Siguiente acción'] = { title: [{ text: { content: cambios.siguiente_accion } }] };
  if (cambios.contexto)         properties['Contexto'] = { select: { name: cambios.contexto } };
  if (cambios.dia_accion)       properties['Dia acción'] = { date: { start: cambios.dia_accion } };
  if (cambios.fecha_limite)     properties['Fecha límite'] = { date: { start: cambios.fecha_limite } };
  if (cambios.me_gustaria_hoy !== null && cambios.me_gustaria_hoy !== undefined) {
    properties['Me gustaría hoy'] = { checkbox: cambios.me_gustaria_hoy };
  }

  await notion.pages.update({ page_id: tarea.id, properties });
  console.log('✏️ Editada:', tarea.titulo);
  return `✏️ *Actualizado* — "${tarea.titulo}" modificada.`;
}

// ─── CREAR EVENTO ─────────────────────────────────────────────────────────────
async function ejecutarCrearEvento(resultado) {
  const cal = getCalendarClient();
  if (!cal) return `⚠️ Calendario no configurado. Avisale a Lucas que agregue GOOGLE_SERVICE_ACCOUNT_JSON a las variables de Cloud Run.`;

  const { evento } = resultado;
  let eventBody = { summary: evento.titulo, description: evento.descripcion || '' };

  if (evento.todo_el_dia || !evento.hora_inicio) {
    eventBody.start = { date: evento.fecha };
    eventBody.end = { date: evento.fecha };
  } else {
    const fin = evento.hora_fin || sumarHora(evento.hora_inicio, 1);
    eventBody.start = { dateTime: `${evento.fecha}T${evento.hora_inicio}:00`, timeZone: 'America/Argentina/Buenos_Aires' };
    eventBody.end = { dateTime: `${evento.fecha}T${fin}:00`, timeZone: 'America/Argentina/Buenos_Aires' };
  }

  const resp = await cal.events.insert({ calendarId: CALENDAR_ID, requestBody: eventBody });
  console.log('📅 Evento creado:', resp.data.id);

  let msg = `📅 *Agendado*\n📌 ${evento.titulo}\n📆 ${evento.fecha}`;
  if (evento.hora_inicio) msg += ` a las ${evento.hora_inicio}`;
  return msg;
}

// ─── CONSULTAR CALENDARIO ────────────────────────────────────────────────────
async function ejecutarConsultarCalendario(resultado) {
  const cal = getCalendarClient();
  if (!cal) return `⚠️ Calendario no configurado todavía.`;

  const { periodo } = resultado;
  const ahora = new Date(); ahora.setHours(0, 0, 0, 0);
  let timeMin = ahora.toISOString();
  let timeMax;
  let titulo;

  if (periodo === 'hoy') {
    const fin = new Date(ahora); fin.setHours(23, 59, 59);
    timeMax = fin.toISOString();
    titulo = '☀️ *Calendario hoy*';
  } else if (periodo === 'mañana') {
    const man = new Date(ahora); man.setDate(man.getDate() + 1);
    timeMin = man.toISOString();
    const finMan = new Date(man); finMan.setHours(23, 59, 59);
    timeMax = finMan.toISOString();
    titulo = '📅 *Calendario mañana*';
  } else {
    const en7 = new Date(ahora); en7.setDate(en7.getDate() + 7);
    timeMax = en7.toISOString();
    titulo = '📋 *Calendario esta semana*';
  }

  const resp = await cal.events.list({ calendarId: CALENDAR_ID, timeMin, timeMax, singleEvents: true, orderBy: 'startTime', maxResults: 20 });
  const eventos = resp.data.items || [];
  if (!eventos.length) return `${titulo}\n\n_Sin eventos._`;

  let msg = `${titulo} — ${eventos.length} evento${eventos.length !== 1 ? 's' : ''}\n`;
  eventos.forEach((e, i) => {
    const hora = e.start.dateTime
      ? new Date(e.start.dateTime).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' })
      : 'Todo el día';
    msg += `\n${i + 1}. ${e.summary} — ${hora}`;
  });
  return msg;
}

// ─── MODIFICAR EVENTO ────────────────────────────────────────────────────────
async function ejecutarModificarEvento(resultado) {
  const cal = getCalendarClient();
  if (!cal) return `⚠️ Calendario no configurado todavía.`;

  const { busqueda, cambios } = resultado;
  const ahora = new Date();
  const en30 = new Date(); en30.setDate(en30.getDate() + 30);

  const resp = await cal.events.list({ calendarId: CALENDAR_ID, timeMin: ahora.toISOString(), timeMax: en30.toISOString(), q: busqueda, singleEvents: true, maxResults: 5 });
  const eventos = resp.data.items || [];
  if (!eventos.length) return `❌ No encontré evento con "${busqueda}" en los próximos 30 días.`;

  const evento = eventos[0];
  const patch = {};
  if (cambios.titulo) patch.summary = cambios.titulo;
  if (cambios.fecha || cambios.hora_inicio) {
    const fecha = cambios.fecha || evento.start.dateTime?.split('T')[0] || evento.start.date;
    const hora  = cambios.hora_inicio || evento.start.dateTime?.split('T')[1]?.substring(0, 5) || '09:00';
    const fin   = cambios.hora_fin || sumarHora(hora, 1);
    patch.start = { dateTime: `${fecha}T${hora}:00`, timeZone: 'America/Argentina/Buenos_Aires' };
    patch.end   = { dateTime: `${fecha}T${fin}:00`,  timeZone: 'America/Argentina/Buenos_Aires' };
  }

  await cal.events.patch({ calendarId: CALENDAR_ID, eventId: evento.id, requestBody: patch });
  console.log('✏️ Evento editado:', evento.summary);
  return `✏️ *Actualizado* — "${evento.summary}" modificado.`;
}

// ─── PLAN DEL DÍA ────────────────────────────────────────────────────────────
async function ejecutarPlanDia() {
  const hoy = fechaISO();
  const [tareas, eventos] = await Promise.all([
    obtenerTareasFecha(hoy),
    obtenerEventosCalendarioRaw('hoy')
  ]);

  let ctx = `Fecha: ${fechaHoy()}\n\n`;
  if (eventos.length) {
    ctx += `AGENDA HOY:\n`;
    eventos.forEach(e => { ctx += `- ${e.hora}: ${e.titulo}\n`; });
    ctx += '\n';
  }
  ctx += `TAREAS PENDIENTES HOY:\n`;
  if (tareas.length) tareas.forEach(t => { ctx += `- [${t.contexto || 'sin contexto'}] ${t.titulo}\n`; });
  else ctx += '- Sin tareas específicas para hoy\n';

  const resp = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 800,
    messages: [{ role: 'user', content: `Sos el secretario de Lucas. Armá un briefing del día conciso. Empezá con la ROCA si hay. Máximo 200 palabras con emojis.\n\n${ctx}` }]
  });

  return `☀️ *Plan de hoy*\n\n${resp.content[0].text}`;
}

// ─── PLAN SEMANAL ────────────────────────────────────────────────────────────
async function ejecutarPlanSemana() {
  const [tareas, eventos] = await Promise.all([
    obtenerTareasSemana(),
    obtenerEventosCalendarioRaw('semana')
  ]);

  let ctx = `Fecha: ${fechaHoy()}\n\n`;
  if (eventos.length) {
    ctx += `AGENDA SEMANA:\n`;
    eventos.forEach(e => { ctx += `- ${e.fecha} ${e.hora}: ${e.titulo}\n`; });
    ctx += '\n';
  }
  ctx += `TAREAS SEMANA:\n`;
  tareas.forEach(t => {
    ctx += `- [${t.contexto || 'sin ctx'}] ${t.titulo}`;
    if (t.dia_accion) ctx += ` (${t.dia_accion})`;
    ctx += '\n';
  });

  const resp = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1000,
    messages: [{ role: 'user', content: `Sos el secretario de Lucas. Armá un plan semanal: 3 metas, ROCA del lunes, tareas por día. Máximo 350 palabras.\n\n${ctx}` }]
  });

  return `📅 *Plan Semanal*\n\n${resp.content[0].text}`;
}

// ─── GUARDAR EN NOTION ────────────────────────────────────────────────────────
async function guardarEnNotion(tarea) {
  const properties = {
    'Siguiente acción': { title: [{ text: { content: tarea.siguiente_accion } }] },
    'Hecho': { checkbox: false }
  };
  if (tarea.contexto)        properties['Contexto'] = { select: { name: tarea.contexto } };
  if (tarea.dia_accion)      properties['Dia acción'] = { date: { start: tarea.dia_accion } };
  if (tarea.fecha_limite)    properties['Fecha límite'] = { date: { start: tarea.fecha_limite } };
  if (tarea.me_gustaria_hoy) properties['Me gustaría hoy'] = { checkbox: true };
  if (tarea.en_espera)       properties['En espera'] = { rich_text: [{ text: { content: tarea.en_espera } }] };
  if (tarea.url)             properties['URL'] = { url: tarea.url };

  return await notion.pages.create({ parent: { database_id: NOTION_DB_ID }, properties });
}

// ─── BUSCAR TAREAS POR TEXTO ──────────────────────────────────────────────────
async function buscarTareasPorTexto(busqueda) {
  // Intentar búsqueda con cada palabra significativa hasta encontrar resultados
  const palabras = busqueda.split(' ').filter(p => p.length > 3);
  
  for (const palabra of palabras) {
    const response = await notion.databases.query({
      database_id: NOTION_DB_ID,
      filter: {
        and: [
          { property: 'Hecho', checkbox: { equals: false } },
          { property: 'Siguiente acción', title: { contains: palabra } }
        ]
      },
      page_size: 10
    });
    if (response.results.length > 0) return response.results.map(mapTarea);
  }

  // Fallback: búsqueda con la frase completa
  const response = await notion.databases.query({
    database_id: NOTION_DB_ID,
    filter: {
      and: [
        { property: 'Hecho', checkbox: { equals: false } },
        { property: 'Siguiente acción', title: { contains: busqueda } }
      ]
    },
    page_size: 10
  });
  return response.results.map(mapTarea);
}

// ─── OBTENER TAREAS PENDIENTES ────────────────────────────────────────────────
async function obtenerTareasPendientes() {
  const response = await notion.databases.query({
    database_id: NOTION_DB_ID,
    filter: {
      and: [
        { property: 'Hecho', checkbox: { equals: false } },
        {
          or: [
            { property: 'Contexto', select: { is_empty: true } },
            { property: 'Contexto', select: { equals: 'ROCA' } },
            { property: 'Contexto', select: { equals: 'T ROCA' } },
            { property: 'Contexto', select: { equals: 'Ordenador' } },
            { property: 'Contexto', select: { equals: 'T Ordenador' } },
            { property: 'Contexto', select: { equals: '< 5 min' } },
            { property: 'Contexto', select: { equals: 'T < 5 min' } },
            { property: 'Contexto', select: { equals: 'Tarea manual casa' } },
            { property: 'Contexto', select: { equals: 'Energía baja' } },
            { property: 'Contexto', select: { equals: 'Tarea fuera de casa' } },
            { property: 'Contexto', select: { equals: 'Leer/Revisar' } },
            { property: 'Contexto', select: { equals: 'T Leer/ Revisar' } },
            { property: 'Contexto', select: { equals: 'T Tarea manual oficina' } },
            { property: 'Contexto', select: { equals: 'T Tarea fuera oficina' } }
          ]
        }
      ]
    },
    sorts: [{ property: 'Dia acción', direction: 'ascending' }],
    page_size: 50
  });
  return response.results.map(mapTarea);
}

// ─── OBTENER TAREAS POR FECHA ─────────────────────────────────────────────────
async function obtenerTareasFecha(fecha) {
  const response = await notion.databases.query({
    database_id: NOTION_DB_ID,
    filter: {
      and: [
        { property: 'Hecho', checkbox: { equals: false } },
        { or: [
          { property: 'Me gustaría hoy', checkbox: { equals: true } },
          { property: 'Dia acción', date: { equals: fecha } }
        ]}
      ]
    }
  });
  return response.results.map(mapTarea);
}

// ─── OBTENER TAREAS SEMANA ────────────────────────────────────────────────────
async function obtenerTareasSemana() {
  const hoy = fechaISO();
  const en7 = new Date(); en7.setDate(en7.getDate() + 7);
  const en7ISO = en7.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });

  const response = await notion.databases.query({
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
  return response.results.map(mapTarea);
}

// ─── OBTENER TAREAS EN ESPERA ─────────────────────────────────────────────────
async function obtenerTareasEnEspera() {
  const response = await notion.databases.query({
    database_id: NOTION_DB_ID,
    filter: {
      and: [
        { property: 'Hecho', checkbox: { equals: false } },
        { property: 'En espera', rich_text: { is_not_empty: true } }
      ]
    }
  });
  return response.results.map(mapTarea);
}

// ─── OBTENER TAREAS POR PROYECTO ──────────────────────────────────────────────
async function obtenerTareasPorProyecto(nombreProyecto) {
  const response = await notion.databases.query({
    database_id: NOTION_DB_ID,
    filter: { property: 'Hecho', checkbox: { equals: false } },
    page_size: 100
  });
  return response.results.map(mapTarea).filter(t =>
    t.titulo.toLowerCase().includes(nombreProyecto.toLowerCase())
  );
}

// ─── OBTENER EVENTOS CALENDARIO (raw para plan) ───────────────────────────────
async function obtenerEventosCalendarioRaw(periodo) {
  try {
    const cal = getCalendarClient();
    if (!cal) return [];
    const ahora = new Date(); ahora.setHours(0, 0, 0, 0);
    let timeMin = ahora.toISOString();
    let timeMax;
    if (periodo === 'hoy') {
      const fin = new Date(ahora); fin.setHours(23, 59, 59);
      timeMax = fin.toISOString();
    } else {
      const en7 = new Date(ahora); en7.setDate(en7.getDate() + 7);
      timeMax = en7.toISOString();
    }
    const resp = await cal.events.list({ calendarId: CALENDAR_ID, timeMin, timeMax, singleEvents: true, orderBy: 'startTime', maxResults: 20 });
    return (resp.data.items || []).map(e => ({
      id: e.id, titulo: e.summary,
      fecha: e.start.date || e.start.dateTime?.split('T')[0],
      hora: e.start.dateTime
        ? new Date(e.start.dateTime).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' })
        : 'Todo el día'
    }));
  } catch (e) {
    console.error('⚠️ Calendar error:', e.message);
    return [];
  }
}

// ─── HELPER: mapear página Notion ─────────────────────────────────────────────
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

// ─── Iniciar servidor ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Segundo Cerebro Bot v4.0 en puerto ${PORT}`);
  console.log(`📋 Notion: ${NOTION_DB_ID}`);
  console.log(`📅 Calendar: ${CALENDAR_ID}`);
  console.log(`📱 Telegram: ${TELEGRAM_TOKEN ? '✅ configurado' : '❌ falta token'}`);
});
