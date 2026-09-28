export const MODES = ['lossless', 'balanced', 'medium', 'strong'] as const
export type CompressionMode = (typeof MODES)[number]
export type LossyMode = Exclude<CompressionMode, 'lossless'>

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

/**
 * Name of the uploaded file inside each request's work directory. Tools
 * only ever see this fixed name, so user-provided names never reach a
 * command line.
 */
export const INPUT_FILE = 'input'

/**
 * An error whose message is safe to show in the UI. Anything else is
 * treated as an internal failure and reported with a generic message.
 */
export class CompressionRejectedError extends Error {
  constructor(
    message: string,
    public status = 422
  ) {
    super(message)
  }
}

export interface CompressionResult {
  /**
   * Path of the file to send back: the compressed candidate, or the
   * original when compression did not make it smaller.
   */
  outputPath: string
  originalSize: number
  outputSize: number
  reduced: boolean
  /**
   * Pages of a PDF or slides of a presentation.
   */
  pageCount?: number
  /**
   * Number of oversized PDF pages scaled down to A4 before compression.
   */
  pagesResized?: number
  /**
   * Images inside a Word or PowerPoint file that were made smaller.
   */
  imagesReduced?: number
  /**
   * Pixel size of an image download.
   */
  width?: number
  height?: number
}
