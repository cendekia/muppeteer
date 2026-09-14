import JSZip from "jszip"
import { DOMParser, XMLSerializer, Document as XmlDocument, Element as XmlElement, Node as XmlNode } from "@xmldom/xmldom"

/** color given to cells that must render without a border */
export const NO_BORDER_COLOR = "#fefefe"

const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

export interface PageSetup {
  /** page size in TWIP (1/20 pt) */
  width: number
  height: number
  /** page margin in TWIP, applied on all sides */
  margin: number
}

const PAGE_SETUPS: Record<string, PageSetup> = {
  tabloid: { width: 15840, height: 24480, margin: 1080 },
  letter: { width: 12240, height: 15840, margin: 1080 },
  a4: { width: 11906, height: 16838, margin: 1080 },
}

export const pageSetupFor = (format: string | undefined, orientation: "portrait" | "landscape"): PageSetup => {
  const setup = PAGE_SETUPS[(format || "").toLowerCase()] || PAGE_SETUPS.tabloid
  return orientation === "landscape" ? { ...setup, width: setup.height, height: setup.width } : setup
}

/** usable width between the margins, in CSS px (1 px = 15 TWIP) */
export const contentWidthPx = (setup: PageSetup): number => Math.floor((setup.width - setup.margin * 2) / 15)

const childElements = (node: XmlNode, name: string): XmlElement[] =>
  Array.from(node.childNodes).filter(
    (child): child is XmlElement => child.nodeType === 1 && (child as XmlElement).nodeName === name
  )

/**
 * The converter writes every table with equal grid columns and no table
 * width, and Word lays tables out from that grid rather than from the cell
 * widths. Rebuild each grid from the first row's cells and pin the layout
 * so Word renders exactly the measured widths.
 */
const pinTableLayout = (doc: XmlDocument, table: XmlElement) => {
  const rows = childElements(table, "w:tr")
  if (rows.length === 0) return

  const widths: number[] = []
  childElements(rows[0], "w:tc").forEach((cell) => {
    const cellProps = childElements(cell, "w:tcPr")[0]
    const cellWidth = cellProps && childElements(cellProps, "w:tcW")[0]
    const span = cellProps && childElements(cellProps, "w:gridSpan")[0]
    const width = cellWidth ? parseInt(cellWidth.getAttribute("w:w") || "0", 10) : 0
    const columns = span ? parseInt(span.getAttribute("w:val") || "1", 10) : 1
    for (let index = 0; index < columns; index++) widths.push(Math.round(width / columns))
  })
  if (widths.length === 0) return

  let grid = childElements(table, "w:tblGrid")[0]
  if (!grid) {
    grid = doc.createElementNS(WORD_NS, "w:tblGrid")
    table.insertBefore(grid, rows[0])
  }
  while (grid.firstChild) grid.removeChild(grid.firstChild)
  widths.forEach((width) => {
    const column = doc.createElementNS(WORD_NS, "w:gridCol")
    column.setAttribute("w:w", String(width))
    grid.appendChild(column)
  })

  let props = childElements(table, "w:tblPr")[0]
  if (!props) {
    props = doc.createElementNS(WORD_NS, "w:tblPr")
    table.insertBefore(props, table.firstChild)
  }
  childElements(props, "w:tblW").concat(childElements(props, "w:tblLayout")).forEach((el) => props.removeChild(el))

  const tableWidth = doc.createElementNS(WORD_NS, "w:tblW")
  tableWidth.setAttribute("w:w", String(widths.reduce((sum, width) => sum + width, 0)))
  tableWidth.setAttribute("w:type", "dxa")
  props.insertBefore(tableWidth, props.firstChild)

  const layout = doc.createElementNS(WORD_NS, "w:tblLayout")
  layout.setAttribute("w:type", "fixed")
  const borders = childElements(props, "w:tblBorders")[0]
  if (borders && borders.nextSibling) props.insertBefore(layout, borders.nextSibling)
  else props.appendChild(layout)
}

/**
 * The converter cannot express "no border" on a cell, so layout cells are
 * written with a sentinel border color and rewritten here to no border.
 */
const clearSentinelBorders = (doc: XmlDocument) => {
  const sentinel = NO_BORDER_COLOR.replace("#", "").toUpperCase()
  const sides = ["w:top", "w:bottom", "w:left", "w:right", "w:start", "w:end", "w:insideH", "w:insideV"]
  Array.from(doc.getElementsByTagName("w:tcBorders")).forEach((borders) => {
    sides.forEach((side) => {
      childElements(borders, side).forEach((border) => {
        if ((border.getAttribute("w:color") || "").toUpperCase() !== sentinel) return
        border.setAttribute("w:val", "nil")
        border.setAttribute("w:sz", "0")
        border.setAttribute("w:color", "auto")
      })
    })
  })
}

/** default spacing after paragraphs, in TWIP: the page is denser than Word's default */
const PARAGRAPH_SPACING_AFTER = 60

/** a paragraph this short in front of a table or picture is a caption or sub-title */
const CAPTION_MAX_CHARS = 120

const paragraphText = (paragraph: XmlElement): string =>
  Array.from(paragraph.getElementsByTagName("w:t"))
    .map((text) => text.textContent || "")
    .join("")

const isHeading = (paragraph: XmlElement): boolean => {
  const props = childElements(paragraph, "w:pPr")[0]
  const style = props && childElements(props, "w:pStyle")[0]
  return !!style && /^Heading\d$/.test(style.getAttribute("w:val") || "")
}

const nextElementSibling = (node: XmlNode): XmlElement | null => {
  let sibling = node.nextSibling
  while (sibling && sibling.nodeType !== 1) sibling = sibling.nextSibling
  return sibling as XmlElement | null
}

const setKeepNext = (doc: XmlDocument, paragraph: XmlElement) => {
  let props = childElements(paragraph, "w:pPr")[0]
  if (!props) {
    props = doc.createElementNS(WORD_NS, "w:pPr")
    paragraph.insertBefore(props, paragraph.firstChild)
  }
  if (childElements(props, "w:keepNext").length) return
  const keepNext = doc.createElementNS(WORD_NS, "w:keepNext")
  // schema order: pStyle comes first, keepNext right after it
  const style = childElements(props, "w:pStyle")[0]
  if (style && style.nextSibling) props.insertBefore(keepNext, style.nextSibling)
  else if (style) props.appendChild(keepNext)
  else props.insertBefore(keepNext, props.firstChild)
}

/**
 * The page keeps each section on one sheet; Word has no such notion, so
 * headings, and short sub-titles standing right before a table or a
 * picture, are told to stay with what follows them.
 */
const keepTitlesWithContent = (doc: XmlDocument) => {
  Array.from(doc.getElementsByTagName("w:p")).forEach((paragraph) => {
    if (isHeading(paragraph)) {
      setKeepNext(doc, paragraph)
      return
    }
    const next = nextElementSibling(paragraph)
    if (!next) return
    const beforeTable = next.nodeName === "w:tbl"
    const beforePicture = next.nodeName === "w:p" && next.getElementsByTagName("w:drawing").length > 0
    if (!beforeTable && !beforePicture) return
    const text = paragraphText(paragraph).trim()
    if (text && text.length <= CAPTION_MAX_CHARS) setKeepNext(doc, paragraph)
  })
}

export async function finalizeDocument(docx: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(docx)
  const documentFile = zip.file("word/document.xml")
  if (!documentFile) return docx

  const doc = new DOMParser().parseFromString(await documentFile.async("string"), "application/xml")
  Array.from(doc.getElementsByTagName("w:tbl")).forEach((table) => pinTableLayout(doc, table))
  clearSentinelBorders(doc)
  keepTitlesWithContent(doc)
  zip.file("word/document.xml", new XMLSerializer().serializeToString(doc))

  const stylesFile = zip.file("word/styles.xml")
  if (stylesFile) {
    const styles = (await stylesFile.async("string")).replace(
      /(<w:pPrDefault>\s*<w:pPr>\s*<w:spacing[^>]*w:after=")\d+(")/,
      `$1${PARAGRAPH_SPACING_AFTER}$2`
    )
    zip.file("word/styles.xml", styles)
  }

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
}
