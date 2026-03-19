require('dotenv').config();
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// ============ Конфигурация ============
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TEMP_API_URL = process.env.TEMP_API_URL || 'http://192.168.4.252:9001/api/latest';
const TEMP_THRESHOLD = Number(process.env.TEMP_THRESHOLD) || 50;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 60 * 1000;  // 1 мин
const REPEAT_ALERT_INTERVAL_MS = 4 * 60 * 60 * 1000;  // 4 часа
const TEMP_JSON_PATH = process.env.TEMP_JSON_PATH || '0.temperature';  // путь в JSON: массив → первый датчик → поле temperature
const STATE_FILE = path.resolve(process.env.STATE_FILE || path.join(__dirname, 'bot-state.json'));

// ============ Состояние ============
let state = 'NORMAL';  // NORMAL | ALERTING
let lastAlertAt = null;  // ms epoch — время последнего алерта (первого или повторного)
let repeatAlertTimer = null;

function loadPersistedState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data.state === 'ALERTING' || data.state === 'NORMAL') {
      state = data.state;
    }
    if (typeof data.lastAlertAt === 'number' && Number.isFinite(data.lastAlertAt)) {
      lastAlertAt = data.lastAlertAt;
    }
    console.log(`Загружено состояние из ${STATE_FILE}: state=${state}, lastAlertAt=${lastAlertAt ? new Date(lastAlertAt).toISOString() : '—'}`);
  } catch (err) {
    console.warn('Не удалось прочитать состояние, начинаем с NORMAL:', err.message);
    state = 'NORMAL';
    lastAlertAt = null;
  }
}

function savePersistedState() {
  try {
    const payload = { state, lastAlertAt };
    fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    console.error('Ошибка записи состояния:', err.message);
  }
}

if (!TELEGRAM_TOKEN || !CHAT_ID) {
  console.error('Укажите TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID в .env');
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

// ——— Логирование TG API в консоль ———
function tgLog(direction, method, data) {
  const ts = new Date().toISOString();
  console.log(`[TG API] ${ts} ${direction} ${method}`, data);
}
const origSendMessage = bot.sendMessage.bind(bot);
bot.sendMessage = function (chatId, text, options) {
  const preview = typeof text === 'string' ? text.slice(0, 120) : String(text).slice(0, 120);
  tgLog('→', 'sendMessage', { chat_id: chatId, text_preview: preview + (preview.length >= 120 ? '…' : '') });
  return origSendMessage(chatId, text, options)
    .then((result) => {
      tgLog('←', 'sendMessage', { chat_id: chatId, ok: true });
      return result;
    })
    .catch((err) => {
      tgLog('←', 'sendMessage', { chat_id: chatId, error: err.message });
      throw err;
    });
};
bot.on('message', (msg) => {
  const text = msg.text || msg.caption || '';
  tgLog('←', 'message', {
    chat_id: msg.chat.id,
    from_id: msg.from?.id,
    from_username: msg.from?.username || null,
    text: text.slice(0, 100) + (text.length > 100 ? '…' : ''),
  });
});
// ———

function getNested(obj, path) {
  return path.split('.').reduce((o, key) => (o && o[key] !== undefined ? o[key] : null), obj);
}

async function fetchTemperature() {
  const res = await axios.get(TEMP_API_URL, { timeout: 10000 });
  const value = getNested(res.data, TEMP_JSON_PATH);
  if (value === null || typeof value !== 'number') {
    throw new Error(`Температура не найдена по пути "${TEMP_JSON_PATH}" в ответе API`);
  }
  return value;
}

/** Текущая температура + краткий статус для ответа в чат */
async function getTemperatureReplyText() {
  const temp = await fetchTemperature();
  const over = temp > TEMP_THRESHOLD;
  return (
    `🌡 Температура: ${temp}°C\n` +
    `📊 Порог: ${TEMP_THRESHOLD}°C\n` +
    `${over ? '⚠️ Сейчас выше порога' : '✅ Сейчас не выше порога'}\n` +
    `📌 Мониторинг: ${state === 'ALERTING' ? 'режим превышения' : 'норма'}`
  );
}

function setupCommands() {
  // В группах команда может быть /temp@BotName
  bot.onText(/\/temp(?:@[\w_]+)?$/i, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const text = await getTemperatureReplyText();
      await bot.sendMessage(chatId, text);
    } catch (err) {
      await bot.sendMessage(chatId, `❌ Не удалось получить температуру: ${err.message}`).catch(() => {});
    }
  });

  bot.onText(/\/start(?:@[\w_]+)?$/i, async (msg) => {
    await bot
      .sendMessage(
        msg.chat.id,
        'Бот мониторит температуру и шлёт алерты в настроенный чат.\n\n' +
          'Команды:\n' +
          '/temp — текущая температура с API'
      )
      .catch(() => {});
  });

  bot.setMyCommands([{ command: 'temp', description: 'Текущая температура' }]).catch((err) => {
    console.warn('setMyCommands:', err.message);
  });
}

function sendAlert(message) {
  bot.sendMessage(CHAT_ID, message).catch((err) => {
    console.error('Ошибка отправки в Telegram:', err.message);
  });
}

/** @param {number} [delayMs] — если не задано, полный интервал 4 ч */
function scheduleRepeatAlert(delayMs) {
  if (repeatAlertTimer) clearTimeout(repeatAlertTimer);
  const delay = delayMs !== undefined ? delayMs : REPEAT_ALERT_INTERVAL_MS;
  repeatAlertTimer = setTimeout(() => {
    repeatAlertTimer = null;
    lastAlertAt = Date.now();
    savePersistedState();
    sendAlert(`⚠️ Повторный алерт: температура всё ещё выше ${TEMP_THRESHOLD}°C. Проверьте датчик.`);
    if (state === 'ALERTING') scheduleRepeatAlert();
  }, delay);
}

/** После перезапуска: следующий повтор через остаток от lastAlertAt */
function restoreRepeatAlertTimerIfAlerting() {
  if (state !== 'ALERTING') return;
  if (lastAlertAt == null) {
    scheduleRepeatAlert(REPEAT_ALERT_INTERVAL_MS);
    return;
  }
  const nextDue = lastAlertAt + REPEAT_ALERT_INTERVAL_MS;
  const delay = Math.max(0, nextDue - Date.now());
  scheduleRepeatAlert(delay);
}

function cancelRepeatAlert() {
  if (repeatAlertTimer) {
    clearTimeout(repeatAlertTimer);
    repeatAlertTimer = null;
  }
}

async function checkTemperature() {
  let temp;
  try {
    temp = await fetchTemperature();
  } catch (err) {
    console.error('Ошибка запроса к API температуры:', err.message);
    return;
  }

  const isOver = temp > TEMP_THRESHOLD;

  if (state === 'NORMAL') {
    if (isOver) {
      state = 'ALERTING';
      lastAlertAt = Date.now();
      savePersistedState();
      sendAlert(
        `🔥 Превышение температуры!\n` +
        `Текущая: ${temp}°C (порог: ${TEMP_THRESHOLD}°C)\n` +
        `Следующий алерт через 4 часа, если температура не снизится.`
      );
      scheduleRepeatAlert();
    }
    return;
  }

  if (state === 'ALERTING') {
    if (isOver) {
      // ничего не делаем — повторный алерт по таймеру раз в 4 часа
    } else {
      state = 'NORMAL';
      lastAlertAt = null;
      savePersistedState();
      cancelRepeatAlert();
      sendAlert(
        `✅ Температура в норме.\n` +
        `Текущая: ${temp}°C (порог: ${TEMP_THRESHOLD}°C). Ожидаем следующего повышения.`
      );
    }
  }
}

function run() {
  loadPersistedState();
  setupCommands();
  restoreRepeatAlertTimerIfAlerting();
  console.log(`Мониторинг: ${TEMP_API_URL}, порог ${TEMP_THRESHOLD}°C, опрос каждые ${POLL_INTERVAL_MS / 1000} с, состояние: ${STATE_FILE}`);
  checkTemperature();
  setInterval(checkTemperature, POLL_INTERVAL_MS);
}

run();
