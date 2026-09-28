import { defineConfig } from '@adonisjs/core/bodyparser'

const bodyParserConfig = defineConfig({
  allowedMethods: ['POST', 'PUT', 'PATCH', 'DELETE'],
  form: {
    convertEmptyStringsToNull: true,
    trimWhitespaces: true,
    types: ['application/x-www-form-urlencoded'],
  },

  json: {
    convertEmptyStringsToNull: true,
    trimWhitespaces: true,
    types: [
      'application/json',
      'application/json-patch+json',
      'application/vnd.api+json',
      'application/csp-report',
    ],
  },

  multipart: {
    autoProcess: true,
    convertEmptyStringsToNull: true,
    trimWhitespaces: true,
    processManually: ['/compress'],
    // Just above the 50 MB per-file limit in the compression controller, so
    // an oversized file fails that check (with a clear message) first
    limit: '51mb',
    types: ['multipart/form-data'],
  },
})

export default bodyParserConfig
