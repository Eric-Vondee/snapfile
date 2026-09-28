# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The product serves two audiences equally:

- Individuals compressing occasional PDFs, including private or sensitive personal documents.
- Office users repeatedly preparing PDFs for sharing, storage, or screen reading.

Both audiences need to understand quality tradeoffs quickly and trust that the operation will not damage or unnecessarily enlarge their document.

## Product Purpose

PDF Compressor is a local web interface for reducing PDF file size. Success means a user can choose a document and an appropriate quality level, understand the consequences, receive the smaller valid file, and keep the original when compression provides no size benefit.

## Positioning

Compression runs through a loopback-only application on the user's computer. The product validates input and output PDFs, preserves page count, returns the original when a candidate is not smaller, and explains the quality implications of each mode before processing.

## Operating Context

The application runs locally in a desktop browser and accepts one PDF up to 50 MB at a time. Users may be preparing a one-off personal document or working through repeated office files. Compression can take up to two minutes for large scanned files.

## Capabilities and Constraints

- Four modes: Lossless, Balanced, Medium, and Strong.
- Balanced is the recommended default when Ghostscript is available.
- qpdf is required for validation and Lossless compression; Ghostscript enables lossy modes.
- Lossy modes reduce image resolution and may resize unusually large scanned pages to fit A4 while preserving orientation and aspect ratio.
- Encrypted, malformed, empty, or unreadable PDFs are rejected with user-facing recovery guidance.
- Digitally signed PDFs may lose signature validity when rewritten.
- Temporary per-request files are removed after the response is prepared.
- The current workflow is single-file. Whether the redesign may reorganize its controls and explanatory copy is an open decision; compression behavior must remain unchanged.

## Brand Commitments

The product name is PDF Compressor. Its voice is direct, calm, technically honest, and free of inflated claims. Privacy, preservation, and transparent tradeoffs are core promises.

The interface stays simple and clean: a neutral, conventional utility look (white card on light grey, Inter, monochrome with semantic red/green only). No themed or concept-driven visual worlds.

## Evidence on Hand

The repository contains the working AdonisJS application, compression service, UI copy, and functional tests. There are no supplied logos, illustrations, customer claims, testimonials, or external brand assets; the redesign must not invent them.

## Product Principles

1. Make the safest useful choice obvious without hiding meaningful consequences.
2. Treat privacy and document integrity as visible product behavior, not fine print.
3. Keep occasional use immediately understandable while making repeat use efficient.
4. Report processing, errors, and outcomes plainly and preserve a fast recovery path.
5. Prefer honest utility over decorative complexity.

## Accessibility & Inclusion

The primary workflow must remain usable with keyboard and assistive technology, expose meaningful processing and error states, maintain readable contrast, and adapt cleanly to mobile widths.
