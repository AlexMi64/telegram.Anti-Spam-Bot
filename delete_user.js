const db = require("./db");

db.run("DELETE FROM users WHERE user_id = 7705404439;", (err) => {
  if (err) {
    console.error("Error deleting user:", err);
  } else {
    console.log("User 7705404439 deleted.");
  }
  process.exit(0);
});
