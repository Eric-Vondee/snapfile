import '@fontsource-variable/inter/opsz.css'
import Alpine from 'alpinejs'
import { zipSync } from 'fflate'

Alpine.data('alert', () => ({
  isVisible: false,
  dismiss() {
    this.isVisible = false
  },
  init() {
    setTimeout(() => {
      this.isVisible = true
    }, 80)
    setTimeout(() => {
      this.dismiss()
    }, 5000)
  },
}))

const prefersDark = window.matchMedia('(prefers-color-scheme: dark)')
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

/**
 * Switches between light and dark. Until the user picks one, the page
 * follows the system setting. The layout applies a saved choice in the
 * head, before first paint.
 */
Alpine.data('themeToggle', () => ({
  dark: false,

  init() {
    this.sync()
    prefersDark.addEventListener('change', () => this.sync())
  },

  sync() {
    const theme = document.documentElement.dataset.theme
    this.dark = theme ? theme === 'dark' : prefersDark.matches
  },

  toggle() {
    const theme = this.dark ? 'light' : 'dark'
    try {
      localStorage.setItem('theme', theme)
    } catch {}

    const apply = () => {
      document.documentElement.dataset.theme = theme
      this.sync()
      return this.$nextTick()
    }
    if (document.startViewTransition && !prefersReducedMotion.matches) {
      document.startViewTransition(apply)
    } else {
      apply()
    }
  },
}))

/**
 * Hover and keyboard readout for the files-per-day chart on the stats
 * page. Screen readers hear the same values through a live region.
 */
Alpine.data('dailyChart', (days) => ({
  days,
  active: null,

  show(index) {
    this.active = index
  },

  hide() {
    this.active = null
  },

  // Keyboard focus starts on the latest day
  enter() {
    if (this.active === null) this.active = this.days.length - 1
  },

  step(offset) {
    this.active = Math.min(this.days.length - 1, Math.max(0, (this.active ?? 0) + offset))
  },

  /**
   * Centered over its column, but kept inside the chart at either edge.
   */
  get tooltipStyle() {
    if (this.active === null) return ''
    const center = ((this.active + 0.5) / this.days.length) * 100
    const edge = this.active < 3 ? 'start' : this.active > this.days.length - 4 ? 'end' : 'middle'
    const shift = { start: '-12px', middle: '-50%', end: 'calc(-100% + 12px)' }[edge]
    return `left: ${center}%; transform: translateX(${shift})`
  },

  describe({ files }) {
    return `${files.toLocaleString('en-US')} ${files === 1 ? 'file' : 'files'}`
  },
}))

/**
 * Messages for failures where the server could not send a JSON error,
 * such as a proxy rejecting an oversized request.
 */
const STATUS_MESSAGES = {
  403: 'The request was rejected. Reload the page and try again.',
  413: 'The file is too large to upload.',
}

const KIND_LABELS = {
  pdf: 'PDF',
  jpeg: 'JPG',
  png: 'PNG',
  webp: 'WebP',
  docx: 'DOCX',
  pptx: 'PPTX',
}

let nextItemId = 0

Alpine.data(
  'compressor',
  ({ maxBytes, maxFiles, mode, modes, pdfModes, missingPdfTool, fileKinds, totals }) => ({
    /**
     * The chosen files. Status goes from ready to working, then to done
     * (with a result) or failed (with an error).
     */
    items: [],
    maxFiles,
    totals,
    mode,
    busy: false,
    zipping: false,
    dragging: false,
    dragDepth: 0,
    elapsed: 0,
    error: null,

    init() {
      this.$watch('mode', () => this.reset())
    },

    /**
     * Kinds of the chosen files, judged from their names. The server checks
     * the contents. Before a file is chosen the modes describe PDFs.
     */
    get kinds() {
      const kinds = new Set(this.items.map((item) => item.kind))
      return kinds.size > 0 ? [...kinds] : ['pdf']
    },

    get isBatch() {
      return this.items.length > 1
    },

    /**
     * True once the files have been sent. Adding files after that starts
     * a new batch, so the results always match the files listed.
     */
    get started() {
      return this.items.some((item) => item.status !== 'ready')
    },

    /**
     * A single file's result is shown in full; a batch gets a summary and
     * a row per file instead.
     */
    get result() {
      return this.isBatch ? null : (this.items[0]?.result ?? null)
    },

    get showBatch() {
      return this.isBatch && this.started
    },

    get done() {
      return this.items.filter((item) => item.result)
    },

    get finished() {
      return this.items.filter((item) => item.status === 'done' || item.status === 'failed').length
    },

    get batchSizes() {
      return this.done.reduce(
        (sizes, { result }) => ({
          originalSize: sizes.originalSize + result.originalSize,
          outputSize: sizes.outputSize + result.outputSize,
        }),
        { originalSize: 0, outputSize: 0 }
      )
    },

    /**
     * Problems with the chosen files, or why a single file failed. In a
     * batch each file shows its own failure in the result list.
     */
    get notice() {
      return this.error ?? (this.isBatch ? null : (this.items[0]?.error ?? null))
    },

    get submitLabel() {
      return this.isBatch ? `Compress ${this.items.length} files` : 'Compress file'
    },

    /**
     * The chosen kind that rules a mode out, if any. A missing PDF tool is
     * named first, since installing it is the fix.
     */
    blocker(value) {
      if (this.kinds.includes('pdf') && !pdfModes.includes(value)) return 'pdf'
      // Lossless keeps every pixel, which JPG and WebP cannot do when re-encoded
      if (value === 'lossless') return this.kinds.find((kind) => kind === 'jpeg' || kind === 'webp')
      return undefined
    },

    canUse(value) {
      return Boolean(value) && !this.blocker(value)
    },

    needsTool(value) {
      return this.blocker(value) === 'pdf'
    },

    modeDetail(value) {
      const { resolution, pixels } = modes.find((option) => option.value === value)
      const blocker = this.blocker(value)
      if (blocker) {
        return blocker === 'pdf' ? `Needs ${missingPdfTool}` : `Not for ${KIND_LABELS[blocker]}`
      }

      // PDF images are measured in dpi; photos, and those inside documents, in pixels
      const pdfs = this.kinds.includes('pdf')
      const others = this.kinds.some((kind) => kind !== 'pdf')
      if (pdfs && others && resolution !== pixels) return `${resolution} · ${pixels}`
      return pdfs ? resolution : pixels
    },

    kindLabel(kind) {
      return KIND_LABELS[kind] ?? ''
    },

    /**
     * Adds files to the list, leaving out any that cannot be compressed
     * and saying why.
     */
    add(fileList) {
      const files = [...(fileList ?? [])]
      if (this.busy || files.length === 0) return
      if (this.started) this.clear()
      this.reset()

      const skipped = { unsupported: [], tooLarge: [], leftOut: 0 }
      for (const file of files) {
        const kind = kindOf(file, fileKinds)
        if (!kind) {
          skipped.unsupported.push(file.name)
          continue
        }
        if (file.size > maxBytes) {
          skipped.tooLarge.push(file.name)
          continue
        }
        // The same file dropped twice is only listed once
        if (this.items.some((item) => sameFile(item.file, file))) continue
        if (this.items.length >= maxFiles) {
          skipped.leftOut++
          continue
        }
        this.items.push({
          id: nextItemId++,
          file,
          kind,
          status: 'ready',
          result: null,
          error: null,
        })
      }
      this.error = skippedMessage(skipped, { maxBytes, maxFiles })

      // A mode picked for another kind of file may not apply to these
      if (!this.canUse(this.mode)) {
        const fallbacks = ['balanced', ...modes.map((option) => option.value)]
        this.mode = fallbacks.find((value) => this.canUse(value)) ?? ''
      }
    },

    remove(item) {
      if (this.busy) return
      // Looked up first: $root is found from the clicked button, whose row
      // is detached once the list updates
      const root = this.$root
      const index = this.items.findIndex((other) => other.id === item.id)
      revoke(item)
      this.items.splice(index, 1)
      this.error = null

      // The removed button had focus; hand it to the row that took its place
      this.$nextTick(() => {
        const buttons = root.querySelectorAll('.file-remove')
        const next = buttons[Math.min(index, buttons.length - 1)] ?? root.querySelector('input')
        next.focus()
      })
    },

    clear() {
      this.items.forEach(revoke)
      this.items = []
    },

    /**
     * The whole window accepts dropped files, so dragging a PDF anywhere
     * highlights the drop zone. A counter is needed because every child
     * element fires its own dragenter and dragleave.
     */
    dragEnter(event) {
      if (this.busy || !hasFiles(event)) return
      this.dragDepth++
      this.dragging = true
    },

    dragLeave(event) {
      if (!hasFiles(event)) return
      this.dragDepth = Math.max(0, this.dragDepth - 1)
      if (this.dragDepth === 0) this.dragging = false
    },

    drop(event) {
      this.dragDepth = 0
      this.dragging = false
      if (this.busy || !event.dataTransfer?.files.length) return
      this.add(event.dataTransfer.files)
    },

    reset() {
      this.error = null
      for (const item of this.items) {
        revoke(item)
        Object.assign(item, { status: 'ready', result: null, error: null })
      }
    },

    /**
     * Each file is its own request, so results show up as they finish and
     * one bad file does not fail the rest. The server decides how many are
     * compressed at the same time.
     */
    async submit() {
      if (this.items.length === 0 || !this.mode || this.busy) return
      this.reset()
      this.busy = true
      const startedAt = Date.now()
      this.elapsed = 0
      const timer = setInterval(() => {
        this.elapsed = Math.floor((Date.now() - startedAt) / 1000)
      }, 1000)

      const action = this.$root.querySelector('form').action
      await Promise.all(this.items.map((item) => this.compress(item, action)))

      clearInterval(timer)
      this.busy = false
      this.restoreFocus()
    },

    async compress(item, action) {
      item.status = 'working'
      const body = new FormData()
      body.append('mode', this.mode)
      body.append('file', item.file)

      try {
        const response = await fetch(action, {
          method: 'POST',
          body,
          headers: {
            'Accept': 'application/json',
            'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').content,
            ...visitorHeader(),
          },
        })

        if (!response.ok) {
          item.error = await errorMessage(response)
        } else if (response.redirected || !response.headers.get('X-File-Kind')) {
          // Shield answers a failed CSRF check with a redirect to the page
          item.error = 'The page expired. Reload it and try again.'
        } else {
          item.result = await readResult(response, item.file.name)
          this.updateTotals(response)
        }
      } catch {
        item.error = 'Could not reach the compressor. Is the server still running?'
      }
      item.status = item.result ? 'done' : 'failed'
    },

    /**
     * The headers are present when the compression was counted. Responses
     * in a batch can arrive out of order, so the highest count wins.
     */
    updateTotals(response) {
      const files = Number(response.headers.get('X-Total-Files'))
      if (files > this.totals.files) {
        this.totals = { files, people: Number(response.headers.get('X-Total-People')) }
      }
    },

    /**
     * Packs every compressed file of a batch into one download. The files
     * are already compressed, so they are stored as they are.
     */
    async downloadAll() {
      if (this.zipping) return
      this.zipping = true
      try {
        const names = new Set()
        const files = {}
        for (const { result } of this.done) {
          const bytes = new Uint8Array(await result.blob.arrayBuffer())
          files[uniqueName(result.filename, names)] = [bytes, { level: 0 }]
        }
        const url = URL.createObjectURL(new Blob([zipSync(files)], { type: 'application/zip' }))
        Object.assign(document.createElement('a'), {
          href: url,
          download: 'compressed-files.zip',
        }).click()
        // Kept until the browser has had time to start the download
        setTimeout(() => URL.revokeObjectURL(url), 10_000)
      } finally {
        this.zipping = false
      }
    },

    /**
     * The submit button is disabled while compressing, which drops focus
     * to the page. Hand it to the next useful control instead, unless the
     * user has already moved on.
     */
    restoreFocus() {
      // x-show reveals elements on the next animation frame
      this.$nextTick(() =>
        requestAnimationFrame(() => {
          const active = document.activeElement
          if (active && active !== document.body && active !== this.$refs.submit) return

          let next = this.$refs.submit
          if (this.result) next = this.$refs.download
          else if (this.isBatch && this.done.length > 1) next = this.$refs.downloadAll
          next.focus()
        })
      )
    },

    itemStatus({ file, status, result, error }) {
      if (status === 'working') return 'Compressing…'
      if (status === 'failed') return error
      if (!result) return formatBytes(file.size)
      if (!result.reduced) return `${formatBytes(result.outputSize)} · Not smaller, original kept`
      return `${formatBytes(result.originalSize)} → ${formatBytes(result.outputSize)}`
    },

    formatBytes,

    formatCount(count) {
      return count.toLocaleString('en-US')
    },

    formatElapsed(seconds) {
      return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
    },

    sizeRatio({ originalSize, outputSize }) {
      return originalSize ? Math.min(1, outputSize / originalSize) : 1
    },

    resultChecks({ kind, pageCount, imagesReduced, width, height }) {
      if (kind === 'pdf') {
        return [
          pageCount === 1 ? 'Page kept' : `All ${pageCount} pages kept`,
          'Checked as a valid PDF',
        ]
      }
      if (kind === 'docx' || kind === 'pptx') {
        const checks = []
        if (kind === 'pptx' && pageCount > 0) {
          checks.push(pageCount === 1 ? 'Slide kept' : `All ${pageCount} slides kept`)
        }
        if (imagesReduced > 0) {
          checks.push(imagesReduced === 1 ? '1 image reduced' : `${imagesReduced} images reduced`)
        }
        checks.push('Text and layout untouched')
        return checks
      }
      return [`${width} × ${height} px`, 'Metadata removed']
    },

    savedPercent({ originalSize, outputSize }) {
      if (!originalSize) return '0%'
      const saved = ((originalSize - outputSize) / originalSize) * 100
      return `${saved.toFixed(saved > 0 && saved < 10 ? 1 : 0)}%`
    },
  })
)

async function readResult(response, fallbackName) {
  const blob = await response.blob()
  const header = (name) => response.headers.get(name)
  return {
    blob,
    url: URL.createObjectURL(blob),
    filename: downloadName(response) ?? fallbackName,
    kind: header('X-File-Kind'),
    originalSize: Number(header('X-Original-Size')),
    outputSize: Number(header('X-Output-Size')),
    reduced: header('X-Reduced') === 'true',
    pagesResized: Number(header('X-Pages-Resized')),
    pageCount: Number(header('X-Page-Count')),
    imagesReduced: Number(header('X-Images-Reduced')),
    width: Number(header('X-Image-Width')),
    height: Number(header('X-Image-Height')),
  }
}

function revoke(item) {
  if (item.result) URL.revokeObjectURL(item.result.url)
}

async function errorMessage(response) {
  if (response.headers.get('Content-Type')?.includes('application/json')) {
    const data = await response.json().catch(() => null)
    if (typeof data?.error === 'string') return data.error
  }
  return STATUS_MESSAGES[response.status] ?? 'Compression failed. Try again.'
}

/**
 * An anonymous random ID used only to count unique people. It stays in
 * this browser and is sent with compressions alone; the server stores a
 * one-way hash of it. Without storage (private modes, blocked site data)
 * the file is still counted, just not the person.
 */
function visitorHeader() {
  try {
    let id = localStorage.getItem('visitor')
    if (!id) {
      id = crypto.randomUUID()
      localStorage.setItem('visitor', id)
    }
    return { 'X-Visitor-Id': id }
  } catch {
    return {}
  }
}

function kindOf(file, fileKinds) {
  const extension = /\.([^.]+)$/.exec(file.name)?.[1].toLowerCase()
  const kinds = Object.entries(fileKinds)
  const match =
    kinds.find(([, { extensions }]) => extensions.includes(extension)) ??
    kinds.find(([, { contentType }]) => contentType === file.type)
  return match?.[0] ?? null
}

function sameFile(a, b) {
  return a.name === b.name && a.size === b.size && a.lastModified === b.lastModified
}

/**
 * Says which chosen files were left out and why, or null when none were.
 */
function skippedMessage({ unsupported, tooLarge, leftOut }, { maxBytes, maxFiles }) {
  const problems = []
  if (unsupported.length > 0) {
    const verb =
      unsupported.length === 1 ? 'is not a supported file type' : 'are not supported file types'
    problems.push(
      `${listNames(unsupported)} ${verb}. Choose PDF, JPG, PNG, WebP, Word (.docx) or PowerPoint (.pptx) files.`
    )
  }
  if (tooLarge.length > 0) {
    const verb = tooLarge.length === 1 ? 'is' : 'are'
    problems.push(
      `${listNames(tooLarge)} ${verb} larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`
    )
  }
  if (leftOut > 0) {
    problems.push(`Up to ${maxFiles} files can be compressed at a time.`)
  }
  return problems.join(' ') || null
}

function listNames(names) {
  const quoted = names.map((name) => `“${name}”`)
  return quoted.length === 1 ? quoted[0] : `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}`
}

/**
 * Two files can compress to the same name, and file systems that ignore
 * case would still overwrite one with the other when unpacking.
 */
function uniqueName(name, taken) {
  let candidate = name
  for (let copy = 2; taken.has(candidate.toLowerCase()); copy++) {
    candidate = name.replace(/(\.[^.]*)?$/, ` (${copy})$1`)
  }
  taken.add(candidate.toLowerCase())
  return candidate
}

function hasFiles(event) {
  return event.dataTransfer?.types.includes('Files') ?? false
}

function downloadName(response) {
  const header = response.headers.get('Content-Disposition') ?? ''
  const encoded = header.match(/filename\*=UTF-8''([^;]+)/)
  return encoded ? decodeURIComponent(encoded[1]) : null
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

Alpine.start()
