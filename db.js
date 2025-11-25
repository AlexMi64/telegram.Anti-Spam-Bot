const sqlite3 = require("sqlite3").verbose();
const path = require("path");

// Создаем и подключаемся к базе данных
const dbPath = path.join(__dirname, "bot.db");
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error("Ошибка подключения к базе данных:", err.message);
  } else {
    console.log("Подключено к базе данных SQLite.");
  }
});

// Создаем таблицу пользователей, если она не существует
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      chat_id INTEGER,
      user_id INTEGER,
      verified INTEGER DEFAULT 0,
      join_time INTEGER,
      PRIMARY KEY (chat_id, user_id)
    )
  `);
});

module.exports = db;
