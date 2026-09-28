import { Env } from '@adonisjs/core/env'

export default await Env.create(new URL('../', import.meta.url), {
  NODE_ENV: Env.schema.enum(['development', 'production', 'test'] as const),
  PORT: Env.schema.number(),
  HOST: Env.schema.string({ format: 'host' }),
  LOG_LEVEL: Env.schema.string(),

  APP_KEY: Env.schema.secret(),
  APP_URL: Env.schema.string({ format: 'url', tld: false }),

  SESSION_DRIVER: Env.schema.enum(['cookie', 'memory'] as const),

  // Usage stats in Turso (optional; without it a local SQLite file is used)
  TURSO_URL: Env.schema.string.optional(),
  TURSO_AUTH_TOKEN: Env.schema.string.optional(),

  // Local usage stats database (optional, defaults to tmp/db.sqlite3)
  DB_FILE: Env.schema.string.optional(),

  // PDF tools (optional, default to "qpdf" and "gs" on the PATH)
  QPDF_BIN: Env.schema.string.optional(),
  GS_BIN: Env.schema.string.optional(),

  // Files compressed at the same time (optional, defaults to the CPU count)
  COMPRESSION_CONCURRENCY: Env.schema.number.optional(),
})
