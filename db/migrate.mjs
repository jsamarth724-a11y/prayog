import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultMigrationsPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

export function runMigrations(database, migrationsPath = defaultMigrationsPath) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = database
    .prepare("SELECT filename FROM schema_migrations")
    .all()
    .map((row) => row.filename);
  const appliedSet = new Set(applied);
  const migrations = fs
    .readdirSync(migrationsPath)
    .filter((filename) => /^\d+_.+\.sql$/i.test(filename))
    .sort((left, right) => left.localeCompare(right));

  for (const filename of migrations) {
    if (appliedSet.has(filename)) continue;
    const sql = fs.readFileSync(path.join(migrationsPath, filename), "utf8");
    const applyMigration = database.transaction(() => {
      database.exec(sql);
      database
        .prepare("INSERT INTO schema_migrations (filename, applied_at) VALUES (?, ?)")
        .run(filename, new Date().toISOString());
    });
    applyMigration();
  }

  return database
    .prepare("SELECT filename, applied_at FROM schema_migrations ORDER BY filename")
    .all();
}
