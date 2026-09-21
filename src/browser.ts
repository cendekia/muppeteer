import puppeteer, { Browser, Page } from "puppeteer"
import environments from "./utils/environments"

/**
 * One Chrome instance shared by every request, plus a small render queue.
 *
 * Previously each request launched its own Chrome and closed it afterwards.
 * Under production load that meant several Chromes starting at once, which
 * showed up as `Target.setAutoAttach timed out`, `IO.read timed out` and the
 * 30s `waitForNetworkIdle` TimeoutError. A single long-lived browser with
 * bounded concurrency keeps memory flat and makes render time predictable.
 */

let browserPromise: Promise<Browser> | null = null

const launchBrowser = async (): Promise<Browser> => {
  const browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: environments.protocolTimeoutMs,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  })

  browser.on("disconnected", () => {
    console.log("browser disconnected, next request will relaunch it")
    browserPromise = null
  })

  return browser
}

export const getBrowser = (): Promise<Browser> => {
  if (!browserPromise) {
    browserPromise = launchBrowser().catch((error) => {
      browserPromise = null
      throw error
    })
  }
  return browserPromise
}

// --- render queue -----------------------------------------------------------

let active = 0
const waiting: Array<() => void> = []

const acquireSlot = (): Promise<void> =>
  new Promise((resolve) => {
    if (active < environments.maxConcurrentRenders) {
      active++
      resolve()
      return
    }
    waiting.push(() => {
      active++
      resolve()
    })
  })

const releaseSlot = (): void => {
  active = Math.max(0, active - 1)
  const next = waiting.shift()
  if (next) next()
}

export const queueStatus = () => ({
  active,
  waiting: waiting.length,
  limit: environments.maxConcurrentRenders,
})

/**
 * Wait for a render slot, then open a page on the shared browser.
 * Always pair with `releasePage` in a `finally`.
 */
export const acquirePage = async (): Promise<Page> => {
  await acquireSlot()
  try {
    const browser = await getBrowser()
    return await browser.newPage()
  } catch (error) {
    releaseSlot()
    throw error
  }
}

export const releasePage = async (page: Page): Promise<void> => {
  try {
    await page.close()
  } catch (error) {
    console.log("error closing page", error)
  } finally {
    releaseSlot()
  }
}

export const closeBrowser = async (): Promise<void> => {
  if (!browserPromise) return
  try {
    const browser = await browserPromise
    await browser.close()
  } catch (error) {
    console.log("error closing browser", error)
  } finally {
    browserPromise = null
  }
}
