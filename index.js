require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const db = require("./db");

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

// Время на проверку в минутах
const VERIFY_TIMEOUT = 5;

// Активные таймеры верификации для их отмены
const activeVerifyTimers = new Map();

// Добавляем глобальное логирование всех updates
bot.on("polling_error", (error) => {
  console.error("Polling error:", error);
});

// Глобальный обработчик всех обновлений для отладки callback
bot.on("update", (update) => {
  if (update.callback_query) {
    console.log(
      `[DEBUG] CALLBACK QUERY в UPDATE:`,
      JSON.stringify(update.callback_query, null, 2),
    );
  }
});

// Обработчик всех callback для отладки
bot.on("callback_query", (query) => {
  console.log(
    `[DEBUG] Получен callback query:`,
    JSON.stringify(query, null, 2),
  );
});
// Функция для проверки пользователя
function isUserVerified(chatId, userId, callback) {
  db.get(
    "SELECT verified FROM users WHERE chat_id = ? AND user_id = ?",
    [chatId, userId],
    (err, row) => {
      if (err) {
        console.error("Ошибка запроса к БД:", err);
        return callback(false);
      }

      // Если пользователя нет в БД, создаем его как непроверенного
      if (!row) {
        console.log(
          `[DB CHECK] Пользователь ${userId} не найден в БД, создаю запись verified = 0`,
        );
        const joinTime = Math.floor(Date.now() / 1000);
        db.run(
          "INSERT INTO users (chat_id, user_id, verified, join_time) VALUES (?, ?, 0, ?)",
          [chatId, userId, joinTime],
          (err2) => {
            if (err2) {
              console.error(
                "[DB CHECK] Ошибка создания записи пользователя:",
                err2,
              );
              return callback(false);
            }
            console.log(
              `[DB CHECK] Создана запись для пользователя ${userId}, verified = 0`,
            );
            callback(false); // Новый пользователь - не верифицирован
          },
        );
        return;
      }

      const isVerified = row.verified === 1;
      console.log(
        `[DB CHECK] Проверка пользователя ${userId} в чате ${chatId}: verified = ${row.verified} (${isVerified ? "YES" : "NO"})`,
      );

      callback(isVerified);
    },
  );
}

// Обработчик новых участников чата
bot.on("new_chat_members", (msg) => {
  const chatId = msg.chat.id;
  const members = msg.new_chat_members;

  members.forEach((user) => {
    if (user.is_bot) return; // Игнорируем ботов

    // Записываем в БД как непроверенного
    const joinTime = Math.floor(Date.now() / 1000);
    db.run(
      "INSERT OR REPLACE INTO users (chat_id, user_id, verified, join_time) VALUES (?, ?, 0, ?)",
      [chatId, user.id, joinTime],
    );

    // Проверяем роль пользователя
    bot
      .getChatMember(chatId, user.id)
      .then((member) => {
        if (member.status !== "creator") {
          // Не ограничиваем владельца
          bot
            .restrictChatMember(chatId, user.id, {
              can_send_messages: false,
              can_send_media_messages: false,
              can_send_other_messages: false,
              can_send_polls: false,
            })
            .catch((err) =>
              console.error("Ошибка ограничения пользователя:", err),
            );
        }
      })
      .catch((err) =>
        console.error("Ошибка получения статуса пользователя:", err),
      );

    console.log(
      `[JOIN] Новый пользователь ${user.username || user.first_name} (${user.id}) ограничен и ждет верификации через сообщение`,
    );

    // Для новых пользователей не отправляем приветственное сообщение
    // Они получат капчу только когда напишут первое сообщение
  });
});

// Обработчик callback от inline кнопок
bot.on("callback_query", (query) => {
  console.log(`=== CALLBACK QUERY RECEIVED ===`);
  console.log(`Query:`, JSON.stringify(query, null, 2));

  const data = query.data;

  // Обработка тестовой кнопки
  if (data.startsWith("test_callback_")) {
    console.log(
      `[TEST CALLBACK] Получен тестовый callback от ${query.from.id}`,
    );
    bot.answerCallbackQuery(query.id, { text: "Тестирование прошло успешно!" });
    return;
  }

  // Обработка captcha кнопок
  if (data.startsWith("captcha_pass_")) {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const parts = data.split("_");
    const targetUserId = parseInt(parts[2]);
    const targetChatId = parts.length > 3 ? parseInt(parts[3]) : chatId;

    console.log(`Callback from user ${userId} in chat ${chatId}: ${data}`);

    // Проверяем соответствие пользователя и правильный чат
    if (userId === targetUserId && chatId === targetChatId) {
      console.log(`User ${userId} passed captcha in chat ${chatId}`);

      // Отменяем таймер бана если он активен
      const timerKey = `${chatId}_${userId}`;
      if (activeVerifyTimers.has(timerKey)) {
        clearTimeout(activeVerifyTimers.get(timerKey));
        activeVerifyTimers.delete(timerKey);
        console.log(`[TIMER] Отменили таймер бана для user ${userId}`);
      }

      // Проверяем, что это верный пользователь
      console.log(
        `[DB UPDATE] Начинаю обновление verified = 1 для user ${userId} в чате ${chatId}`,
      );

      db.run(
        "UPDATE users SET verified = 1 WHERE chat_id = ? AND user_id = ?",
        [chatId, userId],
        function (err) {
          if (err) {
            console.error("[DB UPDATE] Ошибка обновления verified:", err);
          } else {
            console.log(
              `[DB UPDATE] УСПЕХ: Обновлено ${this.changes} строк для user ${userId}`,
            );

            // Проверяем что запись действительно обновлена
            db.get(
              "SELECT verified FROM users WHERE chat_id = ? AND user_id = ?",
              [chatId, userId],
              (err2, row) => {
                if (err2) {
                  console.error(
                    "[DB VERIFY] Ошибка проверки обновления:",
                    err2,
                  );
                } else {
                  console.log(
                    `[DB VERIFY] Проверка после обновления: verified = ${row ? row.verified : "null"}`,
                  );
                }
              },
            );

            // Отвечаем и удаляем сообщение
            bot.answerCallbackQuery(query.id, { text: "Проверка пройдена!" });
            bot.deleteMessage(chatId, query.message.message_id).catch((err) => {
              console.error(
                "[CAPTCHA] Ошибка удаления сообщения:",
                err.message,
              );
            });

            // Проверяем роль и снимаем ограничения, если не владелец
            bot
              .getChatMember(chatId, userId)
              .then((member) => {
                if (member.status !== "creator") {
                  console.log(`[RESTRICT] Снимаю ограничения с user ${userId}`);
                  bot
                    .restrictChatMember(chatId, userId, {
                      can_send_messages: true,
                      can_send_media_messages: true,
                      can_send_other_messages: true,
                      can_send_polls: true,
                    })
                    .catch((err) =>
                      console.error(
                        "[RESTRICT] Ошибка снятия ограничений:",
                        err,
                      ),
                    );
                } else {
                  console.log(
                    `[RESTRICT] Пропускаю снятие ограничений - пользователь creator`,
                  );
                }
              })
              .catch((err) =>
                console.error(
                  "[RESTRICT] Ошибка получения статуса пользователя:",
                  err,
                ),
              );
          }
        },
      );
    } else {
      bot.answerCallbackQuery(query.id, {
        text: "Вертикальная кнопка не ваша.",
      });
    }
  }
});

// Тестовая команда для проверки работы кнопок
bot.onText(/\/test/, (msg) => {
  console.log(
    `[TEST COMMAND] Получена команда /test от ${msg.from.id} в чате ${msg.chat.id}`,
  );

  const testOptions = {
    disable_notification: true,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "Тестовая кнопка",
            callback_data: `test_callback_${msg.from.id}`,
          },
        ],
      ],
    },
  };

  console.log(`[TEST BUTTON] Отправляю тестовую кнопку:`, testOptions);

  bot
    .sendMessage(msg.chat.id, "Нажмите тестовую кнопку:", testOptions)
    .then((sent) => {
      console.log(
        `[TEST BUTTON] Тестовое сообщение отправлено. ID: ${sent.message_id}`,
      );
    })
    .catch((err) => {
      console.error(`[TEST BUTTON] Ошибка отправки:`, err);
    });
});

// Обработчик сообщений - для групп/каналов проверяем верификацию
bot.on("message", (msg) => {
  console.log(
    `New message in ${msg.chat.id} type ${msg.chat.type} from ${msg.from.id}${msg.message_thread_id ? ` (thread: ${msg.message_thread_id})` : ""}`,
  );

  if (msg.chat.type === "private") {
    if (msg.text === "/start") {
      // Можно отправить приветствие для личного чата
    }
  } else if (msg.chat.type === "group" || msg.chat.type === "supergroup") {
    // Игнорируем системные сообщения и сервисные обновления
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
      console.log(
        `[FILTER] Игнорирую системное сообщение или сервисное обновление от ${msg.from ? msg.from.id : "system"}`,
      );
      return;
    }

    isUserVerified(msg.chat.id, msg.from.id, (verified) => {
      console.log(
        `Message from user ${msg.from.id} in chat ${msg.chat.id}, verified: ${verified}${msg.message_thread_id ? ` (thread: ${msg.message_thread_id})` : ""}`,
      );

      if (!verified) {
        // Проверяем роль пользователя
        bot
          .getChatMember(msg.chat.id, msg.from.id)
          .then((member) => {
            if (
              member.status === "creator" ||
              member.status === "administrator"
            ) {
              console.log(
                `User ${msg.from.id} is admin/creator, not verifying.`,
              );
              return;
            }

            // Проверяем, нет ли уже активного таймера верификации для этого пользователя
            const timerKey = `${msg.chat.id}_${msg.from.id}`;
            if (activeVerifyTimers.has(timerKey)) {
              console.log(
                `[SKIP] Пропускаю верификацию для user ${msg.from.id} - уже есть активный таймер`,
              );
              return;
            }

            // Отправляем reply с верификацией в тот же тред/топик если сообщение было там
            const options = {
              disable_notification: true,
              reply_to_message_id: msg.message_id,
              message_thread_id: msg.message_thread_id, // ВАЖНО: сохраняем тред
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "Я не робот",
                      callback_data: `captcha_pass_${msg.from.id}_${msg.chat.id}`,
                    },
                  ],
                ],
              },
            };

            console.log(
              `[BUTTON DEBUG] Отправляю сообщение с верификацией для user ${msg.from.id}${msg.message_thread_id ? ` в треде ${msg.message_thread_id}` : ""}:`,
              options,
            );

            bot
              .sendMessage(
                msg.chat.id,
                `Подтвердите, что вы не робот, нажав на кнопку ниже. У вас 15 секунд.`,
                options,
              )
              .then((sent) => {
                console.log(
                  `[BUTTON DEBUG] Сообщение с верификацией отправлено успешно. Message ID: ${sent.message_id}${sent.message_thread_id ? ` (thread: ${sent.message_thread_id})` : ""}`,
                );

                // Таймер на ограничение если пользователь не верифицируется в 15 секунд
                const restrictTimer = setTimeout(() => {
                  isUserVerified(msg.chat.id, msg.from.id, (nowVerified) => {
                    if (!nowVerified) {
                      console.log(
                        `[RESTRICT] User ${msg.from.id} failed to verify within 15 seconds - restricting messages globally and deleting messages`,
                      );
                      // Применяем ограничение независимо от контекста (топик/основной чат)
                      bot
                        .restrictChatMember(msg.chat.id, msg.from.id, {
                          can_send_messages: false,
                          can_send_media_messages: false,
                          can_send_other_messages: false,
                          can_send_polls: false,
                        })
                        .then(() => {
                          console.log(
                            `Пользователь ${msg.from.id} ограничен ГЛОБАЛЬНО за неуспешную верификацию (не может писать нигде в чате)`,
                          );

                          // Удаляем исходное сообщение пользователя и сообщение с капчей
                          const deletePromises = [
                            bot
                              .deleteMessage(msg.chat.id, msg.message_id)
                              .catch((err) => {
                                console.error(
                                  "[DELETE] Ошибка удаления исходного сообщения пользователя:",
                                  err.message,
                                );
                              }),
                            bot
                              .deleteMessage(msg.chat.id, sent.message_id)
                              .catch((err) => {
                                console.error(
                                  "[CAPTCHA] Ошибка удаления истекшего сообщения с капчей:",
                                  err.message,
                                );
                              }),
                          ];

                          Promise.all(deletePromises).then(() => {
                            console.log(
                              `[DELETE] Исходное сообщение пользователя и капча удалены за ${msg.from.id}`,
                            );
                          });
                        })
                        .catch((err) =>
                          console.error(
                            "[RESTRICT] Ошибка глобального ограничения:",
                            err.message,
                          ),
                        );
                    }
                  });
                }, 15000);

                // Сохраняем таймер для отмены при успешной верификации
                activeVerifyTimers.set(
                  `${msg.chat.id}_${msg.from.id}`,
                  restrictTimer,
                );
              })
              .catch((err) => {
                console.error(
                  `[BUTTON DEBUG] Ошибка отправки сообщения с верификацией:`,
                  err.message,
                );

                // Если тред не найден, пытаемся отправить в основной чат без message_thread_id
                if (
                  err.message.includes("message thread not found") &&
                  options.message_thread_id
                ) {
                  console.log(
                    `[BUTTON DEBUG] Повторная попытка в основной чат без треда`,
                  );

                  const mainChatOptions = {
                    ...options,
                    message_thread_id: undefined, // Убираем тред
                    reply_to_message_id: msg.message_id,
                    reply_markup: options.reply_markup,
                  };

                  bot
                    .sendMessage(
                      msg.chat.id,
                      `Подтвердите, что вы не робот, нажав на кнопку ниже. У вас 15 секунд.`,
                      mainChatOptions,
                    )
                    .then((sent) => {
                      console.log(
                        `[BUTTON DEBUG] Сообщение успешно отправлено в основной чат. Message ID: ${sent.message_id}`,
                      );

                      // Таймер на ограничение для этого fallback сообщения тоже
                      const restrictTimerFallback = setTimeout(() => {
                        isUserVerified(
                          msg.chat.id,
                          msg.from.id,
                          (nowVerified) => {
                            if (!nowVerified) {
                              console.log(
                                `[RESTRICT] User ${msg.from.id} failed to verify within 15 seconds in fallback - restricting messages globally and deleting messages`,
                              );
                              // Применяем ограничение глобально в fallback блоке тоже
                              bot
                                .restrictChatMember(msg.chat.id, msg.from.id, {
                                  can_send_messages: false,
                                  can_send_media_messages: false,
                                  can_send_other_messages: false,
                                  can_send_polls: false,
                                })
                                .then(() => {
                                  console.log(
                                    `Пользователь ${msg.from.id} ограничен ГЛОБАЛЬНО за неуспешную верификацию (fallback)`,
                                  );

                                  // Удаляем исходное сообщение пользователя и сообщение с капчей
                                  const deletePromisesFallback = [
                                    bot
                                      .deleteMessage(
                                        msg.chat.id,
                                        msg.message_id,
                                      )
                                      .catch((err) => {
                                        console.error(
                                          "[DELETE] Ошибка удаления исходного сообщения пользователя (fallback):",
                                          err.message,
                                        );
                                      }),
                                    bot
                                      .deleteMessage(
                                        msg.chat.id,
                                        sent.message_id,
                                      )
                                      .catch((err) => {
                                        console.error(
                                          "[CAPTCHA] Ошибка удаления истекшего сообщения с капчей (fallback):",
                                          err.message,
                                        );
                                      }),
                                  ];

                                  Promise.all(deletePromisesFallback).then(
                                    () => {
                                      console.log(
                                        `[DELETE] Исходное сообщение пользователя и капча удалены за ${msg.from.id} (fallback)`,
                                      );
                                    },
                                  );
                                })
                                .catch((err) =>
                                  console.error(
                                    "[RESTRICT] Ошибка ограничения в fallback:",
                                    err.message,
                                  ),
                                );
                            }
                          },
                        );
                      }, 15000);

                      activeVerifyTimers.set(
                        `${msg.chat.id}_${msg.from.id}`,
                        restrictTimerFallback,
                      );
                    })
                    .catch((err2) => {
                      console.error(
                        `[BUTTON DEBUG] Ошибка отправки в основной чат:`,
                        err2.message,
                      );
                    });
                }
              });
          })
          .catch((err) =>
            console.error(
              "Ошибка получения статуса пользователя в сообщении:",
              err,
            ),
          );
      }
    });
  }
});

console.log("Бот запущен!");

// Проверка статуса бота
bot
  .getMe()
  .then((me) => {
    console.log(`[BOT INFO] Бот работает как @${me.username} (ID: ${me.id})`);
  })
  .catch((err) => {
    console.error(`[BOT ERROR] Не удалось получить информацию о боте:`, err);
  });

// Тестирование polling соединения
setTimeout(() => {
  console.log(`[POLLING TEST] Проверяем работу polling...`);
  bot
    .getUpdates({ offset: -1, limit: 1, timeout: 0 })
    .then((updates) => {
      console.log(`[POLLING TEST] Updates получены: ${updates.length}`);
    })
    .catch((err) => {
      console.error(`[POLLING TEST] Ошибка получения updates:`, err);
    });
}, 5000);
