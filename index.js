const express = require('express');
const axios = require('axios');
const { Client } = require('@notionhq/client');
const Anthropic = require('@anthropic-ai/sdk');
const bodyParser = require('body-parser');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

// Inicializar clientes
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

// Variables de configuración
const NOTION_DATABASE_ID = '2fe6046f0fee81719744f6bd897e0dc3';

// Proyectos/Empresas que maneja Lucas
const PROJECTS = {
  'DLP': 'Daniel Laurenzano Propiedades',
  'Tuluka': 'Tuluka Gym',
  'Smart Developments': 'Smart Developments',
  'Lauren Café': 'Lauren Café',
  'Wawanco': 'Wawanco'
};

// Webhook para recibir mensajes de Google Chat
app.post('/webhook/google-chat', async (req, res) => {
  try {
    console.log('📨 Mensaje recibido:', JSON.stringify(req.body, null, 2));

    const message = req.body.message;
    
    if (!message || !message.text) {
      return res.status(400).send('No text found in message');
    }

    const userText = message.text.trim();
    const spaceId = message.space.name;

    // 1. Procesar el texto con Claude para clasificación
    const classification = await classifyTask(userText);

    // 2. Guardar en Notion
    const notionResponse = await saveToNotion(classification);

    // 3. Responder en Google Chat
    const responseMessage = buildChatResponse(classification);
    
    console.log('✅ Tarea guardada correctamente en Notion');
    console.log('📌 Clasificación:', classification);

    res.status(200).send({ 
      actionResponse: { 
        type: 'UPDATE_MESSAGE', 
        text: responseMessage 
      } 
    });
  } catch (error) {
    console.error('Error en webhook:', error);
    res.status(500).send('Error processing message');
  }
});

/**
 * Clasificar tarea usando Claude
 */
async function classifyTask(taskText) {
  const prompt = `Eres un asistente experto en productividad para Lucas Hernán Laurenzano, CEO de múltiples empresas.

Tu tarea es CLASIFICAR esta tarea/idea que acaba de grabar:
"${taskText}"

PROYECTOS/EMPRESAS que gestiona Lucas:
- DLP (Daniel Laurenzano Propiedades) - Inmobiliaria
- Tuluka - Gimnasio (membresías, churn, KPIs)
- Smart Developments - Desarrollos inmobiliarios (proyectos: SmartBay, SmartPequ, SmartViu, SmartBell)
- Lauren Café - Marca
- Wawanco - Marca

CATEGORÍAS DE ACCIONES (según tiempo):
- "Hacerlo" (< 2 min)
- "En espera" (delegado, esperando respuesta)
- "Calendario" (necesita fecha específica)
- "Proyecto" (subtarea de un proyecto mayor)
- "Acciones siguientes" (próxima acción clara)
- "Basura" (no importante)
- "Algún día" (idea para después)

RESPONDE EN JSON con este formato EXACTO:
{
  "taskTitle": "Título corto de la tarea",
  "project": "DLP|Tuluka|Smart Developments|Lauren Café|Wawanco|Otro",
  "category": "Hacerlo|En espera|Calendario|Proyecto|Acciones siguientes|Basura|Algún día",
  "priority": "Alta|Normal|Baja",
  "estimatedMinutes": número,
  "suggestedDate": "YYYY-MM-DD o null si no aplica",
  "description": "Contexto adicional si existe",
  "relatedTo": "Si menciona 'RE: algo', ponlo aquí, si no null"
}

IMPORTANTE: Sé inteligente. Si dice "Llamar a Enrique" y después "Ofrecerle otra opción RE: llamar a Enrique", entiende que la segunda es una subtarea de la primera.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    messages: [
      {
        role: 'user',
        content: prompt
      }
    ]
  });

  // Extraer JSON de la respuesta
  const content = response.content[0].text;
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  
  if (!jsonMatch) {
    throw new Error('No valid JSON found in Claude response');
  }

  return JSON.parse(jsonMatch[0]);
}

/**
 * Guardar tarea en Notion
 */
async function saveToNotion(classification) {
  try {
    const response = await notion.pages.create({
      parent: {
        database_id: NOTION_DATABASE_ID
      },
      properties: {
        'Siguiente acción': {
          title: [
            {
              text: {
                content: classification.taskTitle
              }
            }
          ]
        },
        'Proyecto': {
          select: {
            name: classification.project
          }
        },
        'Prioridad': {
          select: {
            name: classification.priority
          }
        },
        'Contexto': {
          select: {
            name: classification.category
          }
        },
        'Tiempo estimado': {
          number: classification.estimatedMinutes
        },
        'Descripción': {
          rich_text: [
            {
              text: {
                content: classification.description || ''
              }
            }
          ]
        },
        ...(classification.suggestedDate && {
          'Fecha límite': {
            date: {
              start: classification.suggestedDate
            }
          }
        })
      }
    });

    return response;
  } catch (error) {
    console.error('Error saving to Notion:', error);
    throw error;
  }
}

/**
 * Construir respuesta para Google Chat
 */
function buildChatResponse(classification) {
  return `✅ *Tarea guardada en Notion*

📝 *${classification.taskTitle}*
🏢 Proyecto: ${classification.project}
🎯 Prioridad: ${classification.priority}
⏱️ Tiempo estimado: ${classification.estimatedMinutes} min
📂 Categoría: ${classification.category}

${classification.suggestedDate ? `📅 Fecha sugerida: ${classification.suggestedDate}` : ''}
${classification.relatedTo ? `🔗 Relacionado con: ${classification.relatedTo}` : ''}`;
}

// Health check
app.get('/health', (req, res) => {
  res.status(200).send('Bot is running');
});

// Iniciar servidor
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Servidor ejecutándose en puerto ${PORT}`);
});