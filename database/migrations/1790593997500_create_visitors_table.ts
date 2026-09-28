import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Hashed anonymous browser IDs, one row per browser that has compressed
 * a file. Used only to count unique people.
 */
export default class extends BaseSchema {
  protected tableName = 'visitors'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.string('id', 64).primary()
      table.timestamp('created_at').notNullable().defaultTo(this.now())
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
