import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { runMigrations } from "./migrate.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultDatabasePath = path.join(projectRoot, "data", "visionops.db");
const defaultMigrationsPath = path.join(projectRoot, "migrations");
let connection = null;
let connectionPath = null;

export function getDatabase({
  databasePath = process.env.VISION_OPS_DB_PATH || defaultDatabasePath,
} = {}) {
  const resolvedPath = path.resolve(databasePath);
  if (connection) {
    if (connectionPath !== resolvedPath) {
      throw new Error(
        `SQLite is already open at "${connectionPath}". Close it before opening "${resolvedPath}".`,
      );
    }
    return connection;
  }

  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  connection = new Database(resolvedPath);
  connectionPath = resolvedPath;
  connection.pragma("journal_mode = WAL");
  connection.pragma("foreign_keys = ON");
  return connection;
}

export function initializeDatabase(options = {}) {
  const database = getDatabase(options);
  runMigrations(database, options.migrationsPath || defaultMigrationsPath);
  return database;
}

export function closeDatabase() {
  if (!connection) return;
  connection.close();
  connection = null;
  connectionPath = null;
}

export function getDefaultDatabasePath() {
  return process.env.VISION_OPS_DB_PATH || defaultDatabasePath;
}
