# Segundo Cerebro Bot

Secretario personal de Lucas por Telegram. Le hablás en texto o en audio y él
agenda, consulta y cierra tareas en Notion, maneja el Google Calendar y busca en
Drive. A la noche te escribe él para preguntarte cómo te fue.

Corre en Google Cloud Run, en el proyecto `mi-segundo-cerebro-bot` (us-central1).

## Cómo funciona

```
Telegram ──webhook──► Cloud Run ──► Claude (tool use) ──► Notion / Calendar / Drive
Cloud Scheduler ──/cron/*──► ídem (el bot escribe primero)
```

- **Modelo:** `claude-sonnet-5` con thinking adaptive y tool use nativo. No hay
  intenciones predefinidas: Claude decide qué herramienta usar.
- **Audios:** se transcriben con Whisper en Groq (`whisper-large-v3-turbo`).
- **Prompt caching:** el system está partido en un bloque estable (con
  `cache_control` ttl 1h) y uno volátil con la fecha. El resumen de conversación
  va como primer mensaje `user`, no en el system, para no invalidar el cache.
- **Procesamiento dentro del request:** Cloud Run estrangula la CPU fuera de los
  requests, así que se responde 200 al final, con un `Promise.race` de 25 s de
  paracaídas.

## Sistema GTD + P.A.R.A

**Base de tareas** (`NOTION_DATABASE_ID`):

| Propiedad | Tipo | Para qué |
|---|---|---|
| `Siguiente acción` | title | La tarea, escrita como acción física (verbo + objeto) |
| `Contexto` | select | Dónde o con qué se puede hacer. Prefijo `T` = trabajo |
| `Proyecto` | relation | Al proyecto de la base P.A.R.A |
| `Dia acción` | date | Cuándo pensás hacerla |
| `Fecha límite` | date | Cuándo vence de verdad |
| `En espera` | date | Hasta cuándo está bloqueada esperando a otro |
| `Me gustaría hoy` | checkbox | Intención del día, aparte de la fecha |
| `Hecho` | checkbox | Cerrada |
| `Fecha hecho` | date | **Cuándo** se cerró (ver más abajo) |

**Base P.A.R.A** (proyectos): `Título`, `Categoría P.A.R.A`
(Proyecto/Area/Recurso/Archivado), `Estado Proyecto` (Activo / En Pausa / Futuro /
**Completado**).

## Setup en Notion (a mano, una vez)

Tres cosas que el código necesita y no puede crear solo:

1. **Propiedad `Fecha hecho` (tipo date)** en la base de tareas. Sin ella el bot
   sigue andando, pero las fechas de cierre salen aproximadas por la última
   edición de la página y se reportan como tales. El `/health` avisa si falta.
2. **Valor `Completado`** en el select `Estado Proyecto`.
3. **Capacidad "Insert comments"** en la integración
   (notion.so → Connections → la integración → Capabilities). Sin esto
   `comentar_tarea` muere con `restricted_resource` y no hay informes de tarea.

## Cierre del día

Todas las noches Cloud Scheduler pega en `POST /cron/cierre-dia` y el bot te
escribe con las tareas del día que quedaron sin marcar, **numeradas**, más cuántas
cerraste. Le contestás en lenguaje natural ("hice la 1 y la 3, la 2 pasala a
mañana, en la 1 anotá que quedamos en revisar el precio") y encadena las
herramientas solo.

El mensaje se compone pasando por Claude, no con una plantilla: además de que
queda mejor escrito, el intercambio entra en la memoria de conversación por el
camino normal, que es lo que hace que "la 1 y la 3" signifique algo después.

> **Límite conocido:** la memoria de conversación vive en RAM. Si la instancia se
> recicla entre el mensaje y tu respuesta, el bot pierde la numeración. **No es
> peligroso**: `buscar_y_marcar_hecha` no marca nada cuando hay ambigüedad, así
> que en el peor caso te vuelve a preguntar. Persistir la memoria (Firestore) es
> la mejora pendiente más grande.

Con la misma plomería hay un `POST /cron/plan-dia` opcional para la mañana.

## Endpoints

| Ruta | Qué hace | Auth |
|---|---|---|
| `POST /webhook/telegram` | Mensajes de Telegram | header `X-Telegram-Bot-Api-Secret-Token` |
| `POST /cron/cierre-dia` | Cierre de la noche | header `X-Cron-Secret` |
| `POST /cron/plan-dia` | Plan de la mañana | header `X-Cron-Secret` |
| `GET /health` | Estado real (prueba Notion y Calendar de verdad) | — |

## Variables de entorno

Ver [.env.example](.env.example). Las que no son obvias:

- **`TELEGRAM_ALLOWED_USER_IDS`** — obligatoria. El bot **falla cerrado**: vacía,
  no le contesta a nadie. Tiene escritura sobre Notion y Calendar.
- **`CRON_SECRET`** — sin esto los endpoints de cron quedan cerrados. Es un secret
  propio, distinto al del webhook: son dos superficies y se rotan por separado.
- **`TELEGRAM_CHAT_ID`** — a quién le escribe cuando arranca él. En chat privado
  es igual al user id. Si se omite, usa el primero de la whitelist.
- `CLAUDE_MODEL` / `CLAUDE_EFFORT` — defaults `claude-sonnet-5` y `medium`.

## Desarrollo

```bash
npm install
npm test     # sintaxis + lógica de matching + smoke test de arranque
npm run dev  # polling local, sin webhook
```

> ⚠️ `npm run dev` **borra el webhook de producción**. Al terminar hay que volver
> a registrarlo o el bot en la nube queda mudo.

Los tests no necesitan credenciales: cubren la lógica pura (matching de tareas,
aritmética de fechas) y un arranque real del server contra `/health` y los
endpoints de cron. `node --check` solo, no alcanza — no detecta referencias rotas.

## Deploy

Los secretos van por **Secret Manager**, no por `--set-env-vars`.

```bash
gcloud run deploy mi-segundo-cerebro-bot \
  --source . --region us-central1 --platform managed \
  --allow-unauthenticated --min-instances 1 --max-instances 1 \
  --set-secrets="CLAUDE_API_KEY=claude-api-key:latest,NOTION_TOKEN=notion-token:latest,TELEGRAM_BOT_TOKEN=telegram-bot-token:latest,GROQ_API_KEY=groq-api-key:latest,GOOGLE_OAUTH_REFRESH_TOKEN=google-oauth-refresh-token:latest,TELEGRAM_WEBHOOK_SECRET=telegram-webhook-secret:latest,CRON_SECRET=cron-secret:latest" \
  --set-env-vars="NOTION_DATABASE_ID=...,GOOGLE_CALENDAR_ID=lucas@dlaurenzano.com,TELEGRAM_ALLOWED_USER_IDS=...,TELEGRAM_CHAT_ID=..."
```

- **`--max-instances 1`** no es opcional: el dedupe de updates y la guardia
  anti-doble-envío del cierre viven en memoria.
- **`--min-instances 1`** tampoco, desde que hay cron: con 0, el disparo de las
  21:00 pega contra un contenedor frío y paga 2–4 s antes de empezar.

Registrar el webhook:

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=https://<url-del-servicio>/webhook/telegram" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET"
```

Programar el cierre del día (Buenos Aires es siempre UTC-3, sin horario de verano):

```bash
gcloud scheduler jobs create http cierre-dia \
  --location us-central1 --schedule "0 21 * * *" \
  --time-zone "America/Argentina/Buenos_Aires" \
  --uri "https://<url-del-servicio>/cron/cierre-dia" --http-method POST \
  --headers "X-Cron-Secret=<el-mismo-CRON_SECRET>" \
  --max-retry-attempts 1
```

`--max-retry-attempts 1` para que un reintento no dispare dos cierres. El bot
igual descarta el segundo del mismo día, pero mejor no depender solo de eso.
