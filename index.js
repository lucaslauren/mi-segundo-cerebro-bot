/**
 * SEGUNDO CEREBRO BOT - Cloud Run
 * 
 * Sistema GTD completo integrado con Claude AI + Notion
 * Flujo: Google Chat → Cloud Run → Claude → Notion → Respuesta en Chat
 * 
 * Contextos válidos (con T = Trabajo, sin T = Personal):
 * ROCA, T ROCA, Ordenador, T Ordenador, < 5 min, T < 5 min,
 * Tarea manual casa, Energía baja, algún día/ a lo mejor,
 * T algún día/ a lo mejor, Tarea fuera de casa, Leer/Revisar,
 * T Leer/ Revisar, T Tarea manual oficina, T Tarea fuera oficina
 */

const express = require('express');
const bodyParser = require('body-parser');
const Anthropic = require('@anthropic-ai/sdk');
const { Client } = require('@notionhq/client');
require('dotenv').config();

const app = express();
app.use(bodyParser.json({ limit: '10mb' }));

// ─── Clientes ───────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
const notion = new Client({ auth: process.env.NOTION_TOKEN });

const NOTION_DB_ID = process.env.NOTION_DATABASE_ID;
const GOOGLE_CHAT_KEY = process.env.GOOGLE_CHAT_KEY;
const GOOGLE_CHAT_TOKEN = process.env.GOOGLE_CHAT_TOKEN;

// ─── Contexto del sistema para Claude ───────────────────────────────────────
const SYSTEM_PROMPT = `Sos el asistente personal de Lucas Hernán Laurenzano, CEO de DLP (Daniel Laurenzano Propiedades), 
co-fundador de Smart Developments, y socio en Tuluka/gym. Vivís dentro de su sistema GTD en Notion.

TU ÚNICA FUNCIÓN es analizar mensajes de Lucas y clasificarlos en el sistema GTD. 
Respondés SIEMPRE en JSON válido y nada más. Sin texto adicional. Sin markdown.

SISTEMA GTD DE LUCAS:
- Todo mensaje es un "ciclo abierto" que debe descargarse y clasificarse
- Una tarea válida = acción física concreta (ej: "Llamar a Marian re: CUPULA" NO "tema CUPULA")
- Si la tarea tarda menos de 2 minutos → indicarlo en notas para que la haga ahora
- Máximo 5 proyectos activos simultáneos

PROYECTOS ACTIVOS DE LUCAS:
- SDVL | N3302 (Smart Developments - edificio N3302)
- LAURENGROUP | Contabilidad
- DLP | Avances CUPULA
- SMART | CUPULA + MARIAN

CONTEXTOS DISPONIBLES (elegí el más apropiado):
Sin T = Personal | Con T = Trabajo
- ROCA / T ROCA → tarea de máximo impacto, requiere bloque de 1.5-2hs sin interrupciones
- Ordenador / T Ordenador → requiere computadora
- < 5 min / T < 5 min → tarea rápida, menos de 5 minutos
- Tarea manual casa → tarea física en casa
- Energía baja → tarea que se puede hacer con poco foco
- algún día/ a lo mejor / T algún día/ a lo mejor → sin urgencia, a futuro
- Tarea fuera de casa → requiere salir
- Leer/Revisar / T Leer/ Revisar → lectura o revisión de documento
- T Tarea manual oficina → tarea física en oficina
- T Tarea fuera oficina → requiere salir de la oficina

REGLAS ESTRICTAS:
1. Reescribí siempre como acción física: verbo + objeto + contexto opcional
2. Si menciona una persona esperando respuesta → es "En espera"
3. Si tiene fecha/hora fija → completá "Dia acción" 
4. Si es algo que quiere hacer HOY → "me_gustaria_hoy": true
5. Si el input es ambiguo, inferí la mejor interpretación posible
6. Si menciona más de una tarea → devolvé un array con todas

FORMATO DE RESPUESTA (JSON estricto):
{
  "tareas": [
    {
      "siguiente_accion": "Texto de la acción física reescrita",
      "contexto": "Uno de los contextos válidos exactamente como está escrito arriba",
      "proyecto": "Nombre exacto del proyecto o null",
      "en_espera": "Nombre Persona re: descripción o null",
      "dia_accion": "YYYY-MM-DD o null",
      "fecha_limite": "YYYY-MM-DD o null",
      "me_gustaria_hoy": false,
      "hecho": false,
      "url": null,
      "dos_minutos": false,
      "nota_clasificacion": "Explicación breve de por qué clasificaste así"
    }
  ],
  "mensaje_confirmacion": "Texto conciso para responder en Google Chat confirmando lo que se guardó"
}`;

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'running', version: '2.0.0' });
});

// ─── Webhook principal de Google Chat ────────────────────────────────────────
app.post('/webhook/google-chat', async (req, res) => {
  console.log('📨 Mensaje recibido:', JSON.stringify(req.body, null, 2));

  try {
    const body = req.body;

    // Google Chat nueva API: body.chat.messagePayload.message
    // Google Chat legacy: body.message
    let message = body.message || body.chat?.messagePayload?.message;

    if (!message) {
      console.log('⚠️ No se encontró message en el body');
      return res.status(200).json({ text: '⚠️ Mensaje no reconocido.' });
    }

    // Ignorar mensajes del propio bot
    if (message.sender?.type === 'BOT') {
      return res.status(200).json({ ok: true });
    }

    const userText = message.text?.trim() || message.argumentText?.trim();
    const attachments = message.attachment || [];

    // ── Comandos especiales ──────────────────────────────────────────────────
    if (userText?.toLowerCase() === '/semana') {
      const resp = await procesarPlanSemanal();
      return res.status(200).json({ text: resp });
    }

    if (userText?.toLowerCase() === '/inbox') {
      const resp = await procesarResumenInbox();
      return res.status(200).json({ text: resp });
    }

    if (userText?.toLowerCase() === '/hoy') {
      const resp = await procesarPlanHoy();
      return res.status(200).json({ text: resp });
    }

    if (userText?.toLowerCase() === '/ayuda') {
      return res.status(200).json({ text: getMensajeAyuda() });
    }

    // ── Procesar audio (adjunto) ─────────────────────────────────────────────
    if (attachments.length > 0) {
      return res.status(200).json({ text: '🎙️ Audio recibido. La transcripción de voz está en desarrollo — por ahora mandá el texto directamente.' });
    }

    // ── Procesar mensaje de texto ────────────────────────────────────────────
    if (!userText) {
      return res.status(200).json({ ok: true });
    }

    // Clasificar con Claude y guardar en Notion
    const clasificacion = await clasificarConClaude(userText);

    if (!clasificacion || !clasificacion.tareas?.length) {
      return res.status(200).json({ text: '❌ No pude clasificar eso. Probá con una tarea más específica.' });
    }

    const resultados = [];
    for (const tarea of clasificacion.tareas) {
      const notionPage = await guardarEnNotion(tarea);
      resultados.push({ tarea, notionPage });
      console.log('✅ Guardado en Notion:', notionPage.id);
    }

    const respuesta = buildRespuesta(clasificacion, resultados);
    return res.status(200).json({ text: respuesta });

  } catch (error) {
    console.error('❌ Error en webhook:', error);
    return res.status(200).json({ text: `❌ Error interno: ${error.message}` });
  }
});

// ─── Clasificar con Claude ────────────────────────────────────────────────────
async function clasificarConClaude(texto) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Fecha y hora actual: ${new Date().toLocaleDateString('es-AR', {timeZone: 'America/Argentina/Buenos_Aires', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'})}\n\nClasificá esta entrada de Lucas en su sistema GTD:\n\n"${texto}"`
        }
      ]
    });

    const raw = response.content[0].text.trim();
    console.log('🤖 Claude respondió:', raw);

    // Limpiar posibles markdown fences
    const clean = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);

  } catch (error) {
    console.error('❌ Error en Claude:', error);
    throw new Error(`Claude falló: ${error.message}`);
  }
}

// ─── Guardar en Notion ────────────────────────────────────────────────────────
async function guardarEnNotion(tarea) {
  const properties = {
    'Siguiente acción': {
      title: [{ text: { content: tarea.siguiente_accion } }]
    }
  };

  // Contexto
  if (tarea.contexto) {
    properties['Contexto'] = {
      select: { name: tarea.contexto }
    };
  }

  // Fecha de acción
  if (tarea.dia_accion) {
    properties['Dia acción'] = {
      date: { start: tarea.dia_accion }
    };
  }

  // Fecha límite
  if (tarea.fecha_limite) {
    properties['Fecha límite'] = {
      date: { start: tarea.fecha_limite }
    };
  }

  // Me gustaría hoy
  if (tarea.me_gustaria_hoy) {
    properties['Me gustaría hoy'] = {
      checkbox: true
    };
  }

  // En espera
  if (tarea.en_espera) {
    properties['En espera'] = {
      // En espera puede ser date o rich_text según la DB
      // Usamos rich_text como fallback seguro
      rich_text: [{ text: { content: tarea.en_espera } }]
    };
  }

  // URL
  if (tarea.url) {
    properties['URL'] = {
      url: tarea.url
    };
  }

  // Hecho (siempre false en nueva tarea)
  properties['Hecho'] = {
    checkbox: false
  };

  // Proyecto — búsqueda por nombre para obtener el ID de relación
  if (tarea.proyecto) {
    const proyectoId = await buscarProyecto(tarea.proyecto);
    if (proyectoId) {
      properties['Proyecto'] = {
        relation: [{ id: proyectoId }]
      };
    }
  }

  const page = await notion.pages.create({
    parent: { database_id: NOTION_DB_ID },
    properties
  });

  return page;
}

// ─── Buscar proyecto por nombre ───────────────────────────────────────────────
async function buscarProyecto(nombreProyecto) {
  try {
    const proyectosDbId = process.env.NOTION_PROJECTS_DATABASE_ID;
    if (!proyectosDbId) return null;

    const response = await notion.databases.query({
      database_id: proyectosDbId,
      filter: {
        property: 'Título',
        title: { contains: nombreProyecto.split('|')[1]?.trim() || nombreProyecto }
      }
    });

    if (response.results.length > 0) {
      return response.results[0].id;
    }
    return null;
  } catch (error) {
    console.error('⚠️ No se pudo buscar proyecto:', error.message);
    return null;
  }
}

// ─── Plan semanal ─────────────────────────────────────────────────────────────
async function procesarPlanSemanal() {
  try {
    const tareas = await obtenerTareasPendientes();
    if (tareas.length === 0) return '✅ No tenés tareas pendientes. ¡Inbox vacío!';

    const planResponse = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `Sos el asistente GTD de Lucas Laurenzano. Tenés estas tareas pendientes:\n${JSON.stringify(tareas, null, 2)}\n\nArmá un plan semanal concreto: 3 metas principales, ROCA del lunes, tareas por contexto. Alertá si hay más de 5 proyectos activos. Texto plano con emojis, máximo 300 palabras.`
      }]
    });

    return `📅 *Plan Semanal*\n\n${planResponse.content[0].text}`;
  } catch (error) {
    return `❌ Error al armar plan semanal: ${error.message}`;
  }
}

// ─── Plan de hoy ──────────────────────────────────────────────────────────────
async function procesarPlanHoy() {
  try {
    const hoy = new Date().toISOString().split('T')[0];
    const tareas = await obtenerTareasHoy(hoy);
    if (tareas.length === 0) return '📭 No tenés tareas programadas para hoy. Usá /inbox para ver todo lo pendiente.';

    const planResponse = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Sos el asistente GTD de Lucas. Tareas para hoy (${hoy}):\n${JSON.stringify(tareas, null, 2)}\n\nBriefing conciso: ROCA del día, tareas por contexto, fechas límite. Máximo 200 palabras.`
      }]
    });

    return `☀️ *Plan de hoy (${hoy})*\n\n${planResponse.content[0].text}`;
  } catch (error) {
    return `❌ Error al armar plan del día: ${error.message}`;
  }
}

// ─── Resumen inbox ────────────────────────────────────────────────────────────
async function procesarResumenInbox() {
  try {
    const tareas = await obtenerTareasPendientes();
    const total = tareas.length;
    if (total === 0) return '✅ *Inbox vacío.* ¡Estás al día!';

    const porContexto = {};
    tareas.forEach(t => {
      const ctx = t.contexto || 'Sin contexto';
      if (!porContexto[ctx]) porContexto[ctx] = 0;
      porContexto[ctx]++;
    });

    let msg = `📋 *Inbox — ${total} tarea${total !== 1 ? 's' : ''} pendiente${total !== 1 ? 's' : ''}*\n\n`;
    Object.entries(porContexto).sort((a, b) => b[1] - a[1]).forEach(([ctx, count]) => {
      msg += `• ${ctx}: ${count}\n`;
    });
    msg += `\nUsá /semana para armar el plan semanal o /hoy para ver el día.`;
    return msg;
  } catch (error) {
    return `❌ Error al leer inbox: ${error.message}`;
  }
}

// ─── Obtener tareas pendientes de Notion ──────────────────────────────────────
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

  return response.results.map(page => ({
    id: page.id,
    titulo: page.properties['Siguiente acción']?.title?.[0]?.text?.content || '',
    contexto: page.properties['Contexto']?.select?.name || null,
    proyecto: page.properties['Proyecto']?.relation?.[0]?.id || null,
    dia_accion: page.properties['Dia acción']?.date?.start || null,
    fecha_limite: page.properties['Fecha límite']?.date?.start || null,
    me_gustaria_hoy: page.properties['Me gustaría hoy']?.checkbox || false
  }));
}

// ─── Obtener tareas para hoy ──────────────────────────────────────────────────
async function obtenerTareasHoy(fecha) {
  const response = await notion.databases.query({
    database_id: NOTION_DB_ID,
    filter: {
      and: [
        { property: 'Hecho', checkbox: { equals: false } },
        {
          or: [
            { property: 'Me gustaría hoy', checkbox: { equals: true } },
            { property: 'Dia acción', date: { equals: fecha } }
          ]
        }
      ]
    }
  });

  return response.results.map(page => ({
    titulo: page.properties['Siguiente acción']?.title?.[0]?.text?.content || '',
    contexto: page.properties['Contexto']?.select?.name || null,
    fecha_limite: page.properties['Fecha límite']?.date?.start || null
  }));
}

// ─── Enviar mensaje a Google Chat ─────────────────────────────────────────────
async function enviarMensajeChat(spaceId, texto) {
  if (!spaceId) return;

  const url = `https://chat.googleapis.com/v1/${spaceId}/messages?key=${GOOGLE_CHAT_KEY}&token=${GOOGLE_CHAT_TOKEN}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: texto })
  });

  if (!response.ok) {
    console.error('❌ Error enviando a Google Chat:', await response.text());
  }
}

// ─── Construir respuesta de confirmación ──────────────────────────────────────
function buildRespuesta(clasificacion, resultados) {
  let msg = clasificacion.mensaje_confirmacion || '✅ Tarea guardada en Notion';

  if (resultados.length > 1) {
    msg = `✅ *${resultados.length} tareas guardadas en Notion*\n\n`;
    resultados.forEach((r, i) => {
      msg += `${i + 1}. ${r.tarea.siguiente_accion}`;
      if (r.tarea.contexto) msg += ` — _${r.tarea.contexto}_`;
      msg += '\n';
    });
  } else if (resultados.length === 1) {
    const t = resultados[0].tarea;
    msg = `✅ *Guardado en Notion*\n`;
    msg += `📌 ${t.siguiente_accion}\n`;
    if (t.contexto) msg += `🏷️ Contexto: ${t.contexto}\n`;
    if (t.proyecto) msg += `📁 Proyecto: ${t.proyecto}\n`;
    if (t.dia_accion) msg += `📅 Día: ${t.dia_accion}\n`;
    if (t.dos_minutos) msg += `⚡ *Menos de 2 min — hacelo ahora*\n`;
    if (t.en_espera) msg += `⏳ En espera de: ${t.en_espera}\n`;
  }

  return msg;
}

// ─── Mensaje de ayuda ─────────────────────────────────────────────────────────
function getMensajeAyuda() {
  return `🧠 *Segundo Cerebro Bot — Comandos*

*Captura de tareas:*
Escribí cualquier tarea, idea o "tengo que" y la clasifico automáticamente en tu Notion.

*Comandos:*
• /hoy → Plan del día con tus tareas
• /semana → Revisión semanal y plan
• /inbox → Resumen de tareas pendientes por contexto
• /ayuda → Este mensaje

*Ejemplos de captura:*
• "Llamar al contador sobre BB4360"
• "Revisar propuesta CUPULA antes del viernes"
• "Tengo que comprar ropa para el cumple"
• "Hablar con Marian re: avances Smart"`;
}

// ─── Iniciar servidor ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Segundo Cerebro Bot v2.0 corriendo en puerto ${PORT}`);
  console.log(`📋 Notion DB: ${NOTION_DB_ID}`);
  console.log(`🤖 Claude: claude-haiku-4-5-20251001`);
});
