# Mi Segundo Cerebro Bot 🧠

Bot inteligente que captura tus tareas por Google Chat, las clasifica con Claude, y las guarda automáticamente en Notion.

## Características

✅ Recibe mensajes/audios por Google Chat
✅ Clasifica automáticamente con Claude (Sonnet 4)
✅ Guarda en Notion (Zona de Acción V4)
✅ Identifica proyectos (DLP, Tuluka, Smart Dev, etc.)
✅ Responde confirmando en Google Chat
✅ Ejecuta en Google Cloud Run (serverless)

## Requisitos previos

1. **Google Cloud Project** con APIs activadas:
   - Google Chat API
   - Google Cloud Speech-to-Text API
   - Google Drive API
   - Google Calendar API

2. **Credenciales necesarias:**
   - Token Notion API
   - Clave Claude API
   - Token Google Chat
   - JSON de credenciales de Google Cloud

3. **Herramientas instaladas:**
   - Node.js 18+
   - Google Cloud CLI (`gcloud`)
   - Git

## Setup local (para testing)

### 1. Clonar y preparar

```bash
git clone <tu-repo>
cd mi-segundo-cerebro-bot
npm install
```

### 2. Configurar variables de entorno

```bash
cp .env.example .env
```

Edita `.env` con tus valores reales:
- `NOTION_TOKEN`: Token de tu integración Notion
- `CLAUDE_API_KEY`: Tu clave API de Claude
- `GOOGLE_CHAT_TOKEN`: Token de Google Chat
- `GOOGLE_CHAT_SPACE`: ID del espacio de Google Chat

### 3. Correr localmente

```bash
npm run dev
```

El servidor corre en `http://localhost:8080`

---

## Deploy a Google Cloud Run

### 1. Autenticar con Google Cloud

```bash
gcloud auth login
gcloud config set project mi-segundo-cerebro-bot
```

### 2. Crear Secret Manager para credenciales

```bash
# Guardar el archivo JSON de credenciales
gcloud secrets create google-credentials --data-file=/ruta/a/tu/credentials.json
```

### 3. Desplegar a Cloud Run

```bash
gcloud run deploy mi-segundo-cerebro-bot \
  --source . \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 512Mi \
  --timeout 60 \
  --set-env-vars NOTION_TOKEN=tu_token,CLAUDE_API_KEY=tu_clave,GOOGLE_CHAT_TOKEN=tu_token
```

Google Cloud Run te dará una URL como:
```
https://mi-segundo-cerebro-bot-xxxxx-uc.a.run.app
```

### 4. Configurar webhook en Google Chat

En Google Chat, configura el webhook para apunte a:
```
https://tu-url-cloud-run/webhook/google-chat
```

---

## Flujo de uso

1. **Mandas un mensaje a Google Chat:**
   ```
   "Llamar a Franco sobre UF11A"
   ```

2. **El bot:**
   - Recibe el mensaje
   - Clasifica con Claude
   - Identifica proyecto (DLP, Tuluka, etc.)
   - Guarda en Notion (Zona de Acción)
   - Te contesta confirmando

3. **En Notion aparece:**
   - Título: "Llamar a Franco sobre UF11A"
   - Proyecto: "DLP"
   - Contexto: "Acciones siguientes"
   - Prioridad: "Normal"
   - Fecha límite: si aplica

---

## Variables de entorno

| Variable | Descripción | Ejemplo |
|----------|-------------|---------|
| `NOTION_TOKEN` | Token API de Notion | `ntn_xxx...` |
| `NOTION_DATABASE_ID` | ID de Zona de Acción V4 | `2fe6046f...` |
| `CLAUDE_API_KEY` | Clave API de Claude | `sk-ant-xxx...` |
| `GOOGLE_CHAT_TOKEN` | Token de Google Chat | `xxxxx` |
| `GOOGLE_CHAT_SPACE` | ID del espacio | `spaces/XXXXXX` |
| `PORT` | Puerto (default 8080) | `8080` |
| `NODE_ENV` | Entorno | `production` |

---

## Troubleshooting

### "Error: No text found in message"
- Verifica que el mensaje tenga contenido
- Google Chat debe enviar `message.text`

### "Error saving to Notion"
- Verifica que el token Notion sea válido
- Confirma que `NOTION_DATABASE_ID` es correcto
- Asegúrate que la integración tiene acceso a esa database

### "Error with Claude classification"
- Verifica que `CLAUDE_API_KEY` sea válido
- Comprueba que tienes saldo en la cuenta Claude

### "Error sending Google Chat message"
- Verifica `GOOGLE_CHAT_TOKEN` y `GOOGLE_CHAT_SPACE`
- Asegúrate que el bot tiene permisos en el espacio

---

## Monitoreo

Ver logs en Cloud Run:
```bash
gcloud run logs read mi-segundo-cerebro-bot --limit 50
```

Health check:
```bash
curl https://tu-url-cloud-run/health
```

---

## Próximas fases

**Fase 2:** Análisis semanal y sugerencias
**Fase 3:** Integración Google Calendar
**Fase 4:** Extracción de datos → Sheets automáticos
**Fase 5:** Dashboard de métricas

---

## Soporte

Para problemas o mejoras, abre un issue o contacta a Lucas.
