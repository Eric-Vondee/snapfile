import { resolve } from 'node:path'
import env from '#start/env'
import app from '@adonisjs/core/services/app'
import { defineConfig } from '@adonisjs/lucid'

/**
 * Usage stats live in Turso when TURSO_URL is set, otherwise in a local
 * SQLite file. Tests always use the local file, so they never write to
 * the production database.
 */
const tursoUrl = app.inTest ? undefined : env.get('TURSO_URL')
const tursoToken = env.get('TURSO_AUTH_TOKEN')
const dbFile = env.get('DB_FILE')

const migrations = { naturalSort: true, paths: ['database/migrations'] }

const dbConfig = defineConfig({
  connection: tursoUrl ? 'turso' : 'sqlite',
  connections: {
    sqlite: {
      client: 'better-sqlite3',
      connection: {
        filename: dbFile ? resolve(app.makePath(), dbFile) : app.tmpPath('db.sqlite3'),
      },
      useNullAsDefault: true,
      migrations,
    },
    turso: {
      client: 'libsql',
      connection: {
        filename: tursoToken
          ? `${tursoUrl}?authToken=${encodeURIComponent(tursoToken)}`
          : String(tursoUrl),
      },
      useNullAsDefault: true,
      migrations,
    },
  },
})

export default dbConfig
