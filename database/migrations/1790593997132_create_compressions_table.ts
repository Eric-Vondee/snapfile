import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * One row per file made smaller. Rows are not linked to visitors, so the
 * data cannot show what any one person compressed.
 */
export default class extends BaseSchema {
  protected tableName = 'compressions'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')
      table.string('kind', 8).notNullable()
      table.string('mode', 16).notNullable()
      table.bigInteger('original_size').notNullable()
      table.bigInteger('output_size').notNullable()
      table.timestamp('created_at').notNullable().defaultTo(this.now())
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
