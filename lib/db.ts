import mysql from "mysql2/promise";

let pool: mysql.Pool | null = null;

export function getPool(): mysql.Pool {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0,
      connectTimeout: 300000,
      typeCast: function (field, next) {
        if (
          field.type === "DATETIME" ||
          field.type === "TIMESTAMP" ||
          field.type === "DATE"
        ) {
          return field.string();
        }
        return next();
      },
    });
  }
  return pool;
}

// NOTE: Removed eager default export to prevent pool creation at import time.
// Next.js loads .env.local before module imports, so getPool() is safe.
// For standalone scripts, call getPool() after dotenv config.
