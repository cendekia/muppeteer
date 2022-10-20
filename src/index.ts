import express from "express"
import puppeteer from "puppeteer"
import * as dotenv from "dotenv"
dotenv.config()
import environments from "./utils/environments"
import { ScreenshotOptions } from "puppeteer"

const app = express()

app.get("/", (request, response) => {
  response.json({ message: "Hello Elmo!" })
})

app.get("/pdf", async (request, response) => {
  const url: string = request.query.url as string

  // Create an instance of the chrome browser
  // But disable headless mode !
  const browser = await puppeteer.launch({
    headless: true,
  })

  // Create a new page
  const webPage = await browser.newPage()

  // Configure the navigation timeout
  await webPage.setDefaultNavigationTimeout(0)

  // Navigate to website
  await webPage
    .goto(url, {
      waitUntil: "networkidle0",
    })
    .catch((err) => console.log("error loading url", err))

  const pdf = await webPage.pdf({
    printBackground: true,
    format: "Tabloid",
    margin: {
      top: "20px",
      bottom: "20px",
      left: "20px",
      right: "20px",
    },
  })

  await browser.close()

  response.contentType("application/pdf")
  response.send(pdf)
})

app.get("/image", async (request, response) => {
  const url: string = request.query.url as string
  const type: string = request.query.type as string
  const types = ["png", "jpeg", "webp"]

  if (types.includes(type) === false) {
    response
      .status(400)
      .json({ message: "Supported types are png, jpeg or webp" })
  } else {
    // Create an instance of the chrome browser
    // But disable headless mode !
    const browser = await puppeteer.launch({
      headless: true,
    })

    // Create a new page
    const webPage = await browser.newPage()

    // Configure the navigation timeout
    await webPage.setDefaultNavigationTimeout(0)

    // Navigate to website
    await webPage
      .goto(url, {
        waitUntil: "networkidle0",
      })
      .catch((err) => console.log("error loading url", err))

    const elem = await webPage.$("body")

    interface BoundingBox {
      width: number
      height: number
      x: number
      y: number
    }
    let boundingBox = <BoundingBox>await elem?.boundingBox()

    interface Viewport {
      width: number
      height: number
    }

    await webPage.setViewport(<Viewport>{
      width: 1056,
      height: Math.floor(boundingBox.height),
    })

    boundingBox = {
      width: 1056,
      height: Math.floor(boundingBox.height),
      x: boundingBox.x,
      y: boundingBox.y,
    }

    console.log(boundingBox)
    const png = await webPage.screenshot(<ScreenshotOptions>{
      captureBeyondViewport: true,
      fromSurface: true,
      clip: boundingBox,
    })

    await browser.close()

    response.contentType("image/png")
    response.send(png)
  }
})

app.listen(environments.apiPort, () => {
  console.log(`Server is running on: ${environments.apiPort}`)
})
