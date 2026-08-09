/**
 * Verifica la lógica pura del bot: matching de tareas y aritmética de fechas.
 * No pega contra Notion ni Google — corre con `node scripts/verificar-matching.js`.
 *
 * El caso que da nombre a este archivo es el primero: con tres tareas que dicen
 * "Franco", el bot ANTES marcaba hecha la que Notion devolviera primero, sin
 * preguntar. Ese test tiene que fallar el día que alguien afloje la guarda.
 */

// El módulo construye los clientes al cargarse; con estas vars basta para importarlo.
process.env.CLAUDE_API_KEY ||= 'test';
process.env.NOTION_TOKEN ||= 'test';
process.env.NOTION_DATABASE_ID ||= 'test';
process.env.TELEGRAM_CHAT_ID ||= '5029988668';

const {
  normalizar, palabrasSignificativas, distancia, puntuarTarea,
  sumarDiasISO, sumarMinutos, elegirCandidatos, CHAT_ID_CRON
} = require('../index.js');

let fallos = 0;
function chequear(nombre, condicion, detalle = '') {
  if (condicion) {
    console.log(`  ✅ ${nombre}`);
  } else {
    console.log(`  ❌ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
    fallos++;
  }
}

const HOY = '2026-08-09';
const tarea = (titulo, extra = {}) => ({
  id: `t-${titulo.slice(0, 8)}`, titulo, contexto: null, proyecto: null,
  dia_accion: null, hecho: false, ...extra
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nNormalización');
chequear('saca tildes', normalizar('Tasación') === 'tasacion', normalizar('Tasación'));
chequear('ñ → n', normalizar('Mañana') === 'manana', normalizar('Mañana'));
chequear('saca puntuación', normalizar('¿Llamar a Franco?') === 'llamar a franco', normalizar('¿Llamar a Franco?'));
chequear('colapsa espacios', normalizar('  a   b  ') === 'a b', `"${normalizar('  a   b  ')}"`);

console.log('\nStop words');
chequear('descarta el verbo genérico', !palabrasSignificativas('ya llamé a Franco').includes('llame'),
  JSON.stringify(palabrasSignificativas('ya llamé a Franco')));
chequear('conserva el nombre propio', palabrasSignificativas('ya llamé a Franco').includes('franco'));
chequear('descarta palabras de 2 letras', !palabrasSignificativas('ir a la casa').includes('ir'));

console.log('\nDistancia de edición');
chequear('iguales = 0', distancia('franco', 'franco') === 0);
chequear('un typo = 1', distancia('tasacion', 'tasasion') === 1, String(distancia('tasacion', 'tasasion')));
chequear('corta lejos de max', distancia('franco', 'mercadolibre') === 99);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nEL BUG CRÍTICO: tres tareas con "Franco" → NO puede marcar sola');
{
  const universo = [
    tarea('Llamar a Franco por la tasación'),
    tarea('Mandarle el contrato a Franco'),
    tarea('Reunión con Franco y Julia')
  ];
  const { candidatos, inequivoco } = elegirCandidatos(universo, 'ya llamé a Franco', HOY);
  chequear('encuentra las tres', candidatos.length === 3, `encontró ${candidatos.length}`);
  chequear('NO se considera inequívoco', inequivoco === false, 'marcaría la tarea equivocada en silencio');
  chequear('la más específica va primera', candidatos[0].titulo.includes('tasación'), candidatos[0].titulo);
}

console.log('\nUna sola coincidencia → sí puede marcar sola');
{
  const universo = [tarea('Llamar a Franco por la tasación'), tarea('Comprar pañales')];
  const { candidatos, inequivoco } = elegirCandidatos(universo, 'llamé a Franco', HOY);
  chequear('encuentra una', candidatos.length === 1, `encontró ${candidatos.length}`);
  chequear('es inequívoco', inequivoco === true);
}

console.log('\nCoincidencia exacta que le saca el doble → puede marcar sola');
{
  const universo = [
    tarea('Mandarle los planos a Julia'),
    tarea('Hablar con Julia')     // comparte solo "julia"
  ];
  const { candidatos, inequivoco } = elegirCandidatos(universo, 'mandarle los planos a Julia', HOY);
  chequear('gana la exacta', candidatos[0].titulo === 'Mandarle los planos a Julia', candidatos[0].titulo);
  chequear('es inequívoco', inequivoco === true, `scores: ${candidatos.map(c => c.score).join(', ')}`);
}

console.log('\nTypos de tipeo y de transcripción de audio');
{
  const universo = [tarea('Revisar la tasación del departamento'), tarea('Comprar pañales')];
  const { candidatos } = elegirCandidatos(universo, 'tasasion', HOY);
  chequear('matchea igual con un typo', candidatos.length === 1 && candidatos[0].titulo.includes('tasación'),
    JSON.stringify(candidatos.map(c => c.titulo)));
}

console.log('\nUna pendiente le gana a una ya cerrada');
{
  const universo = [
    tarea('Llamar a Franco', { hecho: true, fecha_hecho: '2026-07-01' }),
    tarea('Llamar a Franco')
  ];
  const { candidatos } = elegirCandidatos(universo, 'llamar a Franco', HOY);
  chequear('la pendiente va primera', candidatos[0].hecho === false,
    `primera: hecho=${candidatos[0].hecho}`);
}

console.log('\nSin coincidencias no inventa');
{
  const universo = [tarea('Comprar pañales'), tarea('Pagar el ABL')];
  const { candidatos, inequivoco } = elegirCandidatos(universo, 'llamar a Franco', HOY);
  chequear('no devuelve nada', candidatos.length === 0);
  chequear('no es inequívoco', inequivoco === false, 'con lista vacía no puede marcar nada');
}

console.log('\nLo que está en juego hoy desempata');
{
  const universo = [
    tarea('Revisar el contrato', { dia_accion: '2026-12-01' }),
    tarea('Revisar el contrato', { dia_accion: '2026-08-09' })
  ];
  const { candidatos } = elegirCandidatos(universo, 'revisar el contrato', HOY);
  chequear('gana la de hoy', candidatos[0].dia_accion === '2026-08-09', candidatos[0].dia_accion);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nFechas (Buenos Aires, siempre UTC-3)');
chequear('mañana', sumarDiasISO('2026-08-09', 1) === '2026-08-10', sumarDiasISO('2026-08-09', 1));
chequear('cruza fin de mes', sumarDiasISO('2026-08-31', 1) === '2026-09-01', sumarDiasISO('2026-08-31', 1));
chequear('cruza fin de año', sumarDiasISO('2026-12-31', 1) === '2027-01-01', sumarDiasISO('2026-12-31', 1));
chequear('año bisiesto', sumarDiasISO('2028-02-28', 1) === '2028-02-29', sumarDiasISO('2028-02-28', 1));
chequear('hacia atrás', sumarDiasISO('2026-08-09', -7) === '2026-08-02', sumarDiasISO('2026-08-09', -7));
chequear('evento de todo el día = start+1', sumarDiasISO('2026-08-09', 1) !== '2026-08-09');
chequear('sumarMinutos', sumarMinutos('09:30', 45) === '10:15', sumarMinutos('09:30', 45));

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nCierre del día: el chat id tiene que ser NÚMERO');
// La memoria de conversación es un Map indexado por chatId. manejarUpdate usa
// message.chat.id, que Telegram manda como número. Si el cierre del día usara el
// string de la env var, escribiría en OTRO bucket de memoria: el mensaje con la
// lista numerada quedaría en un lado y la respuesta de Lucas en otro, y "hice la
// 1 y la 3" no significaría nada. La Map NO equipara 123 con "123".
chequear('CHAT_ID_CRON es number', typeof CHAT_ID_CRON === 'number', `es ${typeof CHAT_ID_CRON}`);
chequear('coincide con un message.chat.id numérico', CHAT_ID_CRON === 5029988668, String(CHAT_ID_CRON));
{
  const m = new Map();
  m.set(5029988668, 'memoria del chat real');
  chequear('la Map encuentra la memoria con esa clave', m.get(CHAT_ID_CRON) === 'memoria del chat real',
    'string y number son claves distintas en una Map');
}

console.log(fallos === 0 ? '\n✅ Todo bien\n' : `\n❌ ${fallos} chequeo(s) fallaron\n`);
process.exit(fallos === 0 ? 0 : 1);
