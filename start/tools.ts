import logger from '@adonisjs/core/services/logger'
import { binaries, detectTools } from '#services/pdf_tools'

const tools = await detectTools()
for (const [name, version] of Object.entries(tools)) {
  if (version === null) {
    logger.warn(
      `"${binaries[name as keyof typeof binaries]}" was not found. Install it with: brew install qpdf ghostscript`
    )
  }
}
