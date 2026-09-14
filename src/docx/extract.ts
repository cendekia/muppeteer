export interface ExtractOptions {
  /** usable page width, in px, inside the generated document */
  contentWidth: number
  /** border color that post-processing turns into "no border" */
  noBorderColor: string
}

/**
 * Rebuilds the rendered page as document-friendly HTML.
 *
 * Runs inside the browser through page.evaluate, so it must stay fully
 * self-contained. Layout is reconstructed from the live geometry: elements
 * sitting side by side become table rows with proportional cells, elements
 * drawn as cards (visible border or own background) become shaded cells,
 * and text runs keep their computed size, weight and color.
 */
export function extractDocumentHtml(options: ExtractOptions): string {
  const SKIP_TAGS = ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "LABEL", "svg", "SVG", "VIDEO", "AUDIO", "IFRAME", "CANVAS", "NEXT-ROUTE-ANNOUNCER"]
  const INLINE_DISPLAYS = ["inline", "inline-block", "inline-flex", "inline-grid", "contents"]
  const MIN_IMAGE_SIZE = 24
  const MAX_FONT_PX = 48
  const WHITE = { r: 255, g: 255, b: 255 }

  type Rgb = { r: number; g: number; b: number }
  type Rgba = Rgb & { a: number }
  type Item = { el: HTMLElement; rect: DOMRect }

  const root = (document.querySelector("main") || document.body) as HTMLElement
  const rootRect = root.getBoundingClientRect()
  const scale = rootRect.width > 0 ? options.contentWidth / rootRect.width : 1
  const noBorder = `border:1px solid ${options.noBorderColor};`

  const escapeHtml = (text: string) =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

  const parseColor = (color: string): Rgba | null => {
    const match = color.match(/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\)/)
    if (!match) return null
    return {
      r: parseFloat(match[1]),
      g: parseFloat(match[2]),
      b: parseFloat(match[3]),
      a: match[4] === undefined ? 1 : parseFloat(match[4]),
    }
  }
  const blend = (top: Rgba, under: Rgb): Rgb => ({
    r: top.r * top.a + under.r * (1 - top.a),
    g: top.g * top.a + under.g * (1 - top.a),
    b: top.b * top.a + under.b * (1 - top.a),
  })
  const toHex = (color: Rgb) =>
    [color.r, color.g, color.b].map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")

  // opaque color visible behind an element, compositing translucent layers over white
  const backgroundBehind = (el: Element | null): Rgb => {
    const layers: Rgba[] = []
    let node: Element | null = el
    while (node && node !== document.documentElement) {
      const color = parseColor(getComputedStyle(node).backgroundColor)
      if (color && color.a > 0) {
        layers.push(color)
        if (color.a >= 1) break
      }
      node = node.parentElement
    }
    let result: Rgb = WHITE
    for (let index = layers.length - 1; index >= 0; index--) {
      result = blend(layers[index], result)
    }
    return result
  }

  const isSkipped = (el: Element) => SKIP_TAGS.includes(el.tagName)
  const isVisible = (el: Element): boolean => {
    const style = getComputedStyle(el)
    if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) === 0) return false
    // overlays and floating controls are page chrome, not content
    if (style.position === "absolute" || style.position === "fixed") return false
    const rect = el.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  const isInline = (el: Element) =>
    el.tagName === "BR" ||
    (!/^H[1-6]$/.test(el.tagName) && INLINE_DISPLAYS.includes(getComputedStyle(el).display))

  // thin decorations (accent bars, hairline dividers) carry no content and
  // would otherwise become their own table cells beside real content
  const isDecoration = (el: HTMLElement): boolean => {
    if (el.tagName === "IMG") return false
    const rect = el.getBoundingClientRect()
    if (rect.width > 12 && rect.height > 12) return false
    if ((el.innerText || "").trim()) return false
    return el.querySelector("img") === null
  }

  // small shaped labels (engagement pills, tags) read as inline badges even
  // when a flex container lays them out as blocks
  const isBadge = (el: Element): boolean => {
    const rect = el.getBoundingClientRect()
    if (rect.height > 40 || rect.width > rootRect.width * 0.3) return false
    const style = getComputedStyle(el)
    const background = parseColor(style.backgroundColor)
    const shaped = parseFloat(style.borderTopLeftRadius) > 0 || (background !== null && background.a > 0)
    if (!shaped) return false
    const text = ((el as HTMLElement).innerText || "").trim()
    if (!text || text.length > 40) return false
    return el.querySelector("div, p, table, ul, ol, img, h1, h2, h3, h4, h5, h6") === null
  }

  // nesting depth inside table cells, where the converter ignores heading styles
  let cellDepth = 0

  // --- text runs -----------------------------------------------------------

  const runStyle = (el: Element): string => {
    const style = getComputedStyle(el)
    const parts: string[] = []
    const size = parseFloat(style.fontSize)
    if (size) parts.push(`font-size:${Math.min(Math.round(size), MAX_FONT_PX)}px`)
    const color = parseColor(style.color)
    if (color) {
      const hex = toHex(blend(color, backgroundBehind(el)))
      if (hex !== "000000") parts.push(`color:#${hex}`)
    }
    if (isInline(el) || isBadge(el)) {
      const background = parseColor(style.backgroundColor)
      if (background && background.a > 0) {
        parts.push(`background-color:#${toHex(blend(background, backgroundBehind(el.parentElement)))}`)
      }
    }
    return parts.join(";")
  }

  const renderText = (text: string, styleSource: Element): string => {
    const collapsed = text.replace(/\s+/g, " ")
    if (!collapsed.trim()) return collapsed ? " " : ""
    const style = getComputedStyle(styleSource)
    let inner = escapeHtml(collapsed)
    if (parseInt(style.fontWeight, 10) >= 600) inner = `<strong>${inner}</strong>`
    if (style.fontStyle === "italic") inner = `<em>${inner}</em>`
    return `<span style="${runStyle(styleSource)}">${inner}</span>`
  }

  const renderImage = (img: HTMLImageElement, avail = options.contentWidth): string => {
    const rect = img.getBoundingClientRect()
    const src = img.currentSrc || img.src
    if (!src || rect.width < MIN_IMAGE_SIZE || rect.height < MIN_IMAGE_SIZE) return ""
    const width = Math.min(Math.round(rect.width * scale), avail)
    const height = Math.round(rect.height * (width / rect.width))
    return `<img src="${escapeHtml(src)}" width="${width}" height="${height}"/>`
  }

  // renders any node as inline content; block descendants are flattened
  const renderInlineNode = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      return renderText(node.textContent || "", node.parentElement as Element)
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return ""
    const el = node as HTMLElement
    if (isSkipped(el)) return ""
    if (el.tagName === "BR") return "<br/>"
    if (el.tagName === "IMG") return renderImage(el as HTMLImageElement)
    if (!isVisible(el)) return ""
    const inner = Array.from(el.childNodes).map(renderInlineNode).join("")
    return isInline(el) ? inner : ` ${inner} `
  }

  const alignmentOf = (el: Element): string => {
    const align = getComputedStyle(el).textAlign
    if (align === "center") return "center"
    if (align === "right" || align === "end") return "right"
    return "left"
  }

  const paragraph = (nodes: Node[], styleSource: Element): string => {
    const inner = nodes.map(renderInlineNode).join("").trim()
    if (!inner) return ""
    return `<p style="text-align:${alignmentOf(styleSource)};">${inner}</p>`
  }

  // --- headings, lists, tables --------------------------------------------

  // the page may only use h4-h6; rank the levels actually present so the
  // document gets Heading 1, 2, 3...
  const headingLevels = Array.from(
    new Set(
      Array.from(root.querySelectorAll("h1, h2, h3, h4, h5, h6"))
        .filter(isVisible)
        .map((heading) => parseInt(heading.tagName.substring(1), 10))
    )
  ).sort()

  const renderHeading = (heading: HTMLElement): string => {
    const text = (heading.innerText || "").replace(/\s+/g, " ").trim()
    if (!text) return ""
    const level = Math.min(headingLevels.indexOf(parseInt(heading.tagName.substring(1), 10)) + 1, 6)
    const textSource = heading.querySelector("p, span, div") || heading
    const style = getComputedStyle(textSource)
    const color = parseColor(style.color)
    const colorCss = color ? `color:#${toHex(blend(color, backgroundBehind(textSource)))};` : ""
    const align = `text-align:${alignmentOf(heading)};`
    if (cellDepth > 0) {
      // inside cells the heading style is lost, so spell the look out on the run
      const size = Math.min(Math.round(parseFloat(style.fontSize) || 16), MAX_FONT_PX)
      return `<p style="${align}"><strong><span style="font-size:${size}px;${colorCss}">${escapeHtml(text)}</span></strong></p>`
    }
    return `<h${level} style="${colorCss}${align}">${escapeHtml(text)}</h${level}>`
  }

  const renderList = (list: HTMLElement): string => {
    const tag = list.tagName === "OL" ? "ol" : "ul"
    const items = Array.from(list.children)
      .filter((child) => child.tagName === "LI" && isVisible(child))
      .map((item) => {
        const parts = Array.from(item.childNodes).map((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node as HTMLElement
            if (el.tagName === "UL" || el.tagName === "OL") return renderList(el)
          }
          return renderInlineNode(node)
        })
        const inner = parts.join("").trim()
        return inner ? `<li>${inner}</li>` : ""
      })
      .join("")
    return items ? `<${tag}>${items}</${tag}>` : ""
  }

  // fits a set of widths (doc px) into the available width
  const fitWidths = (widths: number[], avail: number): number[] => {
    const total = widths.reduce((sum, width) => sum + width, 0)
    if (total <= avail || total === 0) return widths
    const factor = avail / total
    return widths.map((width) => Math.max(1, Math.round(width * factor)))
  }

  const renderTable = (table: HTMLTableElement, avail: number): string => {
    const rows = Array.from(table.querySelectorAll("tr")).filter(isVisible)
    if (rows.length === 0) return ""
    const body = rows
      .map((row) => {
        const cells = Array.from(row.children).filter(
          (cell) => (cell.tagName === "TD" || cell.tagName === "TH") && isVisible(cell)
        ) as HTMLTableCellElement[]
        const widths = fitWidths(
          cells.map((cell) => Math.round(cell.getBoundingClientRect().width * scale)),
          avail
        )
        const rendered = cells
          .map((element, index) => {
            const width = `${widths[index]}px`
            const inner = Array.from(element.childNodes).map(renderInlineNode).join("").trim()
            if (element.tagName === "TH") {
              const background = toHex(backgroundBehind(element))
              return `<th style="width:${width};background-color:#${background};"><strong>${inner}</strong></th>`
            }
            const background = parseColor(getComputedStyle(element).backgroundColor)
            const shading =
              background && background.a > 0
                ? `background-color:#${toHex(blend(background, backgroundBehind(element.parentElement)))};`
                : ""
            return `<td style="width:${width};${shading}"><p style="text-align:${alignmentOf(element)};">${inner}</p></td>`
          })
          .join("")
        return rendered ? `<tr>${rendered}</tr>` : ""
      })
      .join("")
    return body ? `<table>${body}</table>` : ""
  }

  // --- blocks, cards and rows ---------------------------------------------

  // horizontal space a cell loses to its inner margins, in doc px
  const CELL_MARGIN = 22
  // keeps stacked tables apart: Word would otherwise merge adjacent tables
  const TABLE_SPACER = '<p><span style="font-size:6px;">&#160;</span></p>'

  // cell style for elements drawn as cards; null for plain containers
  const cardStyle = (el: HTMLElement): string | null => {
    if (el === root || isBadge(el)) return null
    const rect = el.getBoundingClientRect()
    // a box holding most of the page is a wrapper, not a card
    if (rect.height > rootRect.height * 0.6 || rect.width < 40) return null
    const style = getComputedStyle(el)
    const parentBackground = backgroundBehind(el.parentElement)
    const border = parseColor(style.borderTopColor)
    const hasBorder =
      parseFloat(style.borderTopWidth) > 0 && style.borderTopStyle !== "none" && border !== null && border.a > 0
    const background = parseColor(style.backgroundColor)
    const ownBackground = background && background.a > 0 ? blend(background, parentBackground) : null
    const hasBackground = ownBackground !== null && toHex(ownBackground) !== toHex(parentBackground)
    if (!hasBorder && !hasBackground) return null
    const parts: string[] = []
    if (hasBackground && ownBackground) parts.push(`background-color:#${toHex(ownBackground)};`)
    parts.push(hasBorder && border ? `border:1px solid #${toHex(blend(border, parentBackground))};` : noBorder)
    return parts.join("")
  }

  const renderBadge = (el: HTMLElement, align: string): string =>
    `<p style="text-align:${align};">${renderInlineNode(el).trim()}</p>`

  const inCell = (render: () => string): string => {
    cellDepth += 1
    try {
      return render()
    } finally {
      cellDepth -= 1
    }
  }

  const renderBlockInner = (el: HTMLElement, avail: number): string => {
    switch (el.tagName) {
      case "IMG":
        return renderImage(el as HTMLImageElement, avail)
      case "TABLE":
        return renderTable(el as HTMLTableElement, avail)
      case "UL":
      case "OL":
        return renderList(el)
      case "H1":
      case "H2":
      case "H3":
      case "H4":
      case "H5":
      case "H6":
        return renderHeading(el)
      case "P":
        return paragraph(Array.from(el.childNodes), el)
      default:
        return renderChildren(el, avail)
    }
  }

  const renderBlock = (el: HTMLElement, avail: number): string => {
    if (isBadge(el)) return renderBadge(el, alignmentOf(el))
    const card = cardStyle(el)
    if (!card) return renderBlockInner(el, avail)
    const width = Math.min(Math.round(el.getBoundingClientRect().width * scale), avail)
    const inner = inCell(() => renderBlockInner(el, width - CELL_MARGIN))
    if (!inner) return ""
    return `<table><tr><td style="width:${width}px;${card}">${inner}</td></tr></table>`
  }

  const renderCell = (item: Item, width: number, isLast: boolean): string => {
    if (isBadge(item.el)) {
      return `<td style="width:${width}px;${noBorder}">${renderBadge(item.el, isLast ? "right" : "left")}</td>`
    }
    const inner = inCell(() => renderBlockInner(item.el, width - CELL_MARGIN)) || "<p></p>"
    const style = cardStyle(item.el) || noBorder
    return `<td style="width:${width}px;${style}">${inner}</td>`
  }

  // side-by-side siblings become one table row. Gaps next to cards stay
  // visible as spacer cells; gaps between plain blocks widen the text cell.
  // `leading` is the space before the first item, kept so a lone centered
  // item does not slide to the left edge
  const renderRow = (row: Item[], avail: number, leading = 0): string => {
    type Slot = { item: Item | null; width: number }
    const slots: Slot[] = []
    if (leading > 4) slots.push({ item: null, width: leading })
    row.forEach((item, index) => {
      const isCard = cardStyle(item.el) !== null
      // badges and images must keep their rendered size once the cell's
      // inner margin is taken off, so the margin is added to their slot
      const width =
        isBadge(item.el) || item.el.tagName === "IMG"
          ? Math.round(item.rect.width * scale) + CELL_MARGIN + 4
          : Math.round(item.rect.width * scale)
      if (index > 0) {
        const previous = row[index - 1]
        const gap = Math.round((item.rect.left - previous.rect.right) * scale)
        if (gap > 4) {
          const previousIsCard = cardStyle(previous.el) !== null
          if (isCard || previousIsCard) {
            slots.push({ item: null, width: gap })
          } else {
            slots[slots.length - 1].width += gap
          }
        }
      }
      slots.push({ item, width })
    })
    const widths = fitWidths(slots.map((slot) => slot.width), avail)
    const cells = slots.map((slot, index) =>
      slot.item
        ? renderCell(slot.item, widths[index], index === slots.length - 1)
        : `<td style="width:${widths[index]}px;${noBorder}"><p></p></td>`
    )
    return `<table><tr>${cells.join("")}</tr></table>`
  }

  const joinBlocks = (parts: string[]): string =>
    parts
      .filter(Boolean)
      .reduce((joined, part, index, all) => {
        const previous = all[index - 1]
        const separator = index > 0 && previous.startsWith("<table") && part.startsWith("<table") ? TABLE_SPACER : ""
        return joined + separator + part
      }, "")

  // a small icon or a short run of text with no block structure of its own
  const isCompact = (item: Item): boolean => {
    const { el, rect } = item
    if (el.tagName === "IMG") return rect.width <= 64 && rect.height <= 64
    if (rect.height > 64 || cardStyle(el) !== null || isBadge(el)) return false
    return el.querySelector("table, ul, ol, img") === null
  }

  // a row of compact items sitting next to each other (an icon beside a
  // number, a bullet beside a label) reads as one line of text, not a table
  const isCompactRow = (row: Item[], avail: number): boolean => {
    if (row.length < 2 || !row.every(isCompact)) return false
    for (let index = 1; index < row.length; index++) {
      if ((row[index].rect.left - row[index - 1].rect.right) * scale > 12) return false
    }
    // a wide text-only row is a layout of columns, not a line; a figure
    // beside its icon may fill a narrow card almost entirely
    const span = (row[row.length - 1].rect.right - row[0].rect.left) * scale
    const hasImage = row.some((item) => item.el.tagName === "IMG")
    return span <= avail * (hasImage ? 0.95 : 0.6)
  }

  // where a flex/grid container places its content; falls back to text-align
  const contentAlignment = (container: HTMLElement): string => {
    const style = getComputedStyle(container)
    if (style.display.includes("flex") || style.display.includes("grid")) {
      const justify = style.justifyContent
      if (justify === "center" || justify === "space-around" || justify === "space-evenly") return "center"
      if (justify === "flex-end" || justify === "end" || justify === "right") return "right"
      if (justify !== "normal" && justify !== "flex-start" && justify !== "start" && justify !== "left") return "left"
    }
    return alignmentOf(container)
  }

  const renderCompactRow = (row: Item[], container: HTMLElement): string => {
    const parts = row.map((item) =>
      item.el.tagName === "IMG"
        ? renderImage(item.el as HTMLImageElement)
        : renderInlineNode(item.el).trim()
    )
    const inner = parts.filter(Boolean).join(" ")
    return inner ? `<p style="text-align:${contentAlignment(container)};">${inner}</p>` : ""
  }

  const renderBlocks = (blocks: HTMLElement[], avail: number, container: HTMLElement): string => {
    const items: Item[] = blocks.map((el) => ({ el, rect: el.getBoundingClientRect() }))
    const containerStyle = getComputedStyle(container)
    const contentLeft = container.getBoundingClientRect().left + parseFloat(containerStyle.paddingLeft)
    const rows: Item[][] = []
    items.forEach((item) => {
      const current = rows[rows.length - 1]
      if (current) {
        const first = current[0]
        const last = current[current.length - 1]
        const beside = item.rect.left >= last.rect.right - 2
        const overlapsVertically = item.rect.top < first.rect.bottom - 2 && item.rect.bottom > first.rect.top + 2
        if (beside && overlapsVertically) {
          current.push(item)
          return
        }
      }
      rows.push([item])
    })
    return joinBlocks(
      rows.map((row) => {
        if (isCompactRow(row, avail)) return renderCompactRow(row, container)
        const leading = Math.round((row[0].rect.left - contentLeft) * scale)
        if (row.length > 1) return renderRow(row, avail, leading)
        // a lone block placed away from the left edge (a centered card) keeps its offset
        if (leading > 4 && cardStyle(row[0].el) !== null) return renderRow(row, avail, leading)
        return renderBlock(row[0].el, avail)
      })
    )
  }

  // walks a container: inline runs become paragraphs, block children are
  // grouped into rows by their rendered position
  const renderChildren = (el: HTMLElement, avail: number): string => {
    const output: string[] = []
    let inlineNodes: Node[] = []
    let blockElements: HTMLElement[] = []
    const flushInline = () => {
      if (inlineNodes.length) output.push(paragraph(inlineNodes, el))
      inlineNodes = []
    }
    const flushBlocks = () => {
      if (blockElements.length) output.push(renderBlocks(blockElements, avail, el))
      blockElements = []
    }

    Array.from(el.childNodes).forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        if ((node.textContent || "").trim()) {
          flushBlocks()
          inlineNodes.push(node)
        } else if (inlineNodes.length) {
          // whitespace between inline siblings keeps words apart
          inlineNodes.push(node)
        }
        return
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return
      const child = node as HTMLElement
      if (isSkipped(child)) return
      if (child.tagName === "BR" || (isVisible(child) && isInline(child))) {
        flushBlocks()
        inlineNodes.push(child)
        return
      }
      if (!isVisible(child) || isDecoration(child)) return
      flushInline()
      blockElements.push(child)
    })
    flushInline()
    flushBlocks()
    return joinBlocks(output)
  }

  return `<div>${renderChildren(root, options.contentWidth)}</div>`
}
