import '@fontsource-variable/inter/opsz.css'
import Alpine from 'alpinejs'

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
 * such as the body parser rejecting an oversized request.
 */
const STATUS_MESSAGES = {
  403: 'The request was rejected. Reload the page and try again.',
  413: 'The file is larger than 50 MB.',
}

const UNSUPPORTED_MESSAGE =
  'This file type is not supported. Choose a PDF, JPG, PNG, WebP, Word (.docx) or PowerPoint (.pptx) file.'

const KIND_LABELS = {
  pdf: 'PDF',
  jpeg: 'JPG',
  png: 'PNG',
  webp: 'WebP',
  docx: 'DOCX',
  pptx: 'PPTX',
}

Alpine.data(
  'compressor',
  ({ maxBytes, mode, modes, pdfModes, missingPdfTool, fileKinds, totals }) => ({
    file: null,
    totals,
    mode,
    busy: false,
    dragging: false,
    dragDepth: 0,
    elapsed: 0,
    error: null,
    result: null,

    init() {
      this.$watch('mode', () => this.reset())
    },

    /**
     * Kind of the chosen file, judged from its name. The server checks the
     * contents. Before a file is chosen the modes describe PDFs.
     */
    get kind() {
      return (this.file && kindOf(this.file, fileKinds)) ?? 'pdf'
    },

    canUse(value) {
      if (!value) return false
      if (this.kind === 'pdf') return pdfModes.includes(value)
      // Lossless keeps every pixel, which JPG and WebP cannot do when re-encoded
      return value !== 'lossless' || !['jpeg', 'webp'].includes(this.kind)
    },

    modeDetail(value) {
      const { resolution, pixels } = modes.find((option) => option.value === value)
      if (this.canUse(value)) return this.kind === 'pdf' ? resolution : pixels
      return this.kind === 'pdf' ? `Needs ${missingPdfTool}` : `Not for ${KIND_LABELS[this.kind]}`
    },

    kindLabel(kind) {
      return KIND_LABELS[kind] ?? ''
    },

    pick(files) {
      this.reset()
      const file = files?.[0] ?? null
      if (file && (file.size > maxBytes || !kindOf(file, fileKinds))) {
        this.file = null
        this.$refs.input.value = ''
        this.error = file.size > maxBytes ? STATUS_MESSAGES[413] : UNSUPPORTED_MESSAGE
        return
      }
      this.file = file

      // A mode picked for another kind of file may not apply to this one
      if (!this.canUse(this.mode)) {
        const fallbacks = ['balanced', ...modes.map((option) => option.value)]
        this.mode = fallbacks.find((value) => this.canUse(value)) ?? ''
      }
    },

    /**
     * The whole window accepts a dropped file, so dragging a PDF anywhere
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
      this.pick(event.dataTransfer.files)
    },

    reset() {
      this.error = null
      if (this.result) URL.revokeObjectURL(this.result.url)
      this.result = null
    },

    async submit() {
      if (!this.file || !this.mode || this.busy) return
      this.reset()
      this.busy = true
      const startedAt = Date.now()
      this.elapsed = 0
      const timer = setInterval(() => {
        this.elapsed = Math.floor((Date.now() - startedAt) / 1000)
      }, 1000)

      const body = new FormData()
      body.append('mode', this.mode)
      body.append('file', this.file)

      try {
        const response = await fetch(this.$root.querySelector('form').action, {
          method: 'POST',
          body,
          headers: {
            'Accept': 'application/json',
            'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').content,
            ...visitorHeader(),
          },
        })

        if (!response.ok) {
          this.error = await errorMessage(response)
          return
        }
        // Shield answers a failed CSRF check with a redirect to the page
        if (response.redirected || !response.headers.get('X-File-Kind')) {
          this.error = 'The page expired. Reload it and try again.'
          return
        }

        const blob = await response.blob()
        this.result = {
          url: URL.createObjectURL(blob),
          filename: downloadName(response) ?? this.file.name,
          kind: response.headers.get('X-File-Kind'),
          originalSize: Number(response.headers.get('X-Original-Size')),
          outputSize: Number(response.headers.get('X-Output-Size')),
          reduced: response.headers.get('X-Reduced') === 'true',
          pagesResized: Number(response.headers.get('X-Pages-Resized')),
          pageCount: Number(response.headers.get('X-Page-Count')),
          imagesReduced: Number(response.headers.get('X-Images-Reduced')),
          width: Number(response.headers.get('X-Image-Width')),
          height: Number(response.headers.get('X-Image-Height')),
        }

        // Present when the compression was counted
        const files = Number(response.headers.get('X-Total-Files'))
        if (files > 0) {
          this.totals = { files, people: Number(response.headers.get('X-Total-People')) }
        }
      } catch {
        this.error = 'Could not reach the compressor. Is the server still running?'
      } finally {
        clearInterval(timer)
        this.busy = false
        this.restoreFocus()
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

          const next = this.result ? this.$refs.download : this.$refs.submit
          next.focus()
        })
      )
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
