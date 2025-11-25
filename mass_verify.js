require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const db = require("./db");

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

// Статистика работы
let stats = {
  messages_processed: 0,
  users_verified: 0,
  chats_tracked: new Set(),
  start_time: new Date(),
};

// Добавляем глобальное логирование всех updates
bot.on("polling_error", (error) => {
  console.error("[MASS_VERIFY] Polling error:", error);
});

// Функция для верификации пользователя
function verifyUser(chatId, userId, callback) {
  const joinTime = Math.floor(Date.now() / 1000);

  // Вставляем или обновляем запись пользователя
  db.run(
    "INSERT OR REPLACE INTO users (chat_id, user_id, verified, join_time) VALUES (?, ?, 1, ?)",
    [chatId, userId, joinTime],
    function (err) {
      if (err) {
        console.error(
          `[MASS_VERIFY] Ошибка верификации user ${userId} в чате ${chatId}:`,
          err,
        );
        if (callback) callback(false);
      } else {
        console.log(
          `[MASS_VERIFY] ✅ Верифицирован user ${userId} в чате ${chatId}`,
        );
        stats.users_verified++;
        stats.chats_tracked.add(chatId);
        if (callback) callback(true);
      }
    },
  );
}

// Показать статистику
function showStats() {
  const uptime = Math.floor((new Date() - stats.start_time) / 1000 / 60); // минуты
  console.log(`
[MASS_VERIFY STATS] ===============================
⏱️  Время работы: ${uptime} минут
📨 Сообщений обработано: ${stats.messages_processed}
✅ Пользователей верифицировано: ${stats.users_verified}
🗂️  Чатов отслеживается: ${stats.chats_tracked.size}
=================================================
  `);
}

// Показывать статистику каждые 5 минут
setInterval(showStats, 5 * 60 * 1000);

// Обработчик сообщений
bot.on("message", (msg) => {
  stats.messages_processed++;

  // Проверяем что это сообщение из группы/супергруппы
  if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") {
    return;
  }

  // Игнорируем системные сообщения и ботов
  if (
    msg.from.is_bot ||
    msg.from.id === 777000 ||
    msg.from.id === 1087968824 ||
    msg.left_chat_member ||
    msg.new_chat_members ||
    msg.left_chat_participant ||
    msg.chat_member ||
    msg.chat_join_request
  ) {
    return;
  }

  // Игнорируем сообщения без текста (стикеры, фото и т.д.)
  if (!msg.text && !msg.caption) {
    return;
  }

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || msg.from.first_name || "Unknown";

  console.log(
    `[MASS_VERIFY] Обрабатывается сообщение от ${username} (${userId}) в чате ${chatId}`,
  );

  // Верифицируем пользователя сразу
  verifyUser(chatId, userId, (success) => {
    if (success) {
      console.log(
        `[MASS_VERIFY] Пользователь ${username} (${userId}) успешно верифицирован в чате ${chatId}`,
      );
    }
  });
});

console.log(`
[MASS_VERIFY] ========================================
🚀 МАССОВАЯ ВЕРИФИКАЦИЯ ЗАПУЩЕНА!

🤖 Bot запущен для автоматической верификации пользователей
📊 Статистика показывается каждые 5 минут
⚡ Все активные участники будут верифицированы автоматически

Остановите бота через неделю и запустите основной с капчей
================================================
`);

// Проверка статуса бота
bot
  .getMe()
  .then((me) => {
    console.log(
      `[MASS_VERIFY] 🤖 Бот работает как @${me.username} (ID: ${me.id})`,
    );
  })
  .catch((err) => {
    console.error(
      `[MASS_VERIFY] ❌ Не удалось получить информацию о боте:`,
      err,
    );
  });

// Показать начальную статистику через 10 секунд
setTimeout(showStats, 10000);
