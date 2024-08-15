import express from "express"
import puppeteer from "puppeteer"
import * as dotenv from "dotenv"
dotenv.config()
import environments from "./utils/environments"
import { ScreenshotOptions } from "puppeteer"
import { PaperFormat } from "puppeteer"
import cors from 'cors';

const app = express()

app.use(cors({ origin: '*' }));

app.get("/", (request, response) => {
  response.json({ message: "Hello Elmo!" })
})

app.get("/pdf", async (request, response) => {
  const url: string = request.query.url as string
  const format: string = request.query.format as string;
  const formats = ["Letter", "Legal", "Tabloid", "Ledger", "A0", "A1", "A2", "A3", "A4", "A5", "A6"];
  const showPageNumber: boolean = request.query.show_page_number === "true";
  const filename: string = request.query.filename as string || "document";
  const download: boolean = request.query.download === "true";

  let browser;

  try {
    // Create an instance of the chrome browser
    // But disable headless mode !
    browser = await puppeteer.launch({
      headless: true,
    });

    // Create a new page
    const webPage = await browser.newPage();

    // Configure the navigation timeout
    await webPage.setDefaultNavigationTimeout(0);

    // Navigate to website
    await webPage
      .goto(url, {
        waitUntil: "networkidle0",
      })
      .catch((err) => console.log("error loading url", err))

    await webPage.waitForNetworkIdle();

    // wait by blocking execution flow

    await new Promise((resolve) => setTimeout(resolve, 5000))

    const pdf = await webPage.pdf({
      printBackground: true,
      format: formats.includes(format) ? format as PaperFormat : "Tabloid",
      displayHeaderFooter: showPageNumber,
      footerTemplate: showPageNumber ? `<div style="text-align: right;width: 297mm;font-size: 12px;"><span style="margin-right: 1cm"><span class="pageNumber"></span>/<span class="totalPages"></span></span></div>` : "",
      margin: {
        top: "20px",
        bottom: showPageNumber ? "40px" : "20px",
        left: "20px",
        right: "20px",
      },
    })

    if (download) {
      response.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename=${filename}.pdf`,
        "Content-Length": pdf.length,
      });
      
      response.end(pdf);
    } else {
      response.contentType("application/pdf")
      response.send(pdf)
    }
  } catch (error) {
    console.error(error)
    response.status(500).json({ message: "Internal Server Error" })
  } finally {
    if (browser) {
      await browser.close()
    }
  }
})

app.get("/image", async (request, response) => {
  const url: string = request.query.url as string
  const type: string = request.query.type as string
  const types = ["png", "jpeg", "webp"]

  if (!types.includes(type)) {
    response.status(400).json({ message: "Supported types are png, jpeg or webp" });
    return;
  }

  let browser;
  try {
    // Create an instance of the chrome browser
    // But disable headless mode !
    browser = await puppeteer.launch({
      headless: true,
    })

    // Create a new page
    const webPage = await browser.newPage()

    // Configure the navigation timeout
    webPage.setDefaultNavigationTimeout(0)

    // Navigate to website
    await webPage
      .goto(url, {
        waitUntil: "networkidle0",
      })
      .catch((err) => console.log("error loading url", err))

    await webPage.waitForNetworkIdle();

    // wait by blocking execution flow
    await new Promise((resolve) => setTimeout(resolve, 5000))
    
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

    // delay to allow the page to render
    await new Promise((resolve) => setTimeout(resolve, 5000))

    const png = await webPage.screenshot(<ScreenshotOptions>{
      captureBeyondViewport: true,
      fromSurface: true,
      clip: boundingBox,
    })

    response.contentType("image/png")
    response.send(png)
  } catch (error) {
    console.error("Error generating image:", error);
    response.status(500).send("Internal Server Error");
  } finally {
    if (browser) {
      await browser.close();
    }
  }
})

app.listen(environments.apiPort, () => {
  console.log(`Server is running on: ${environments.apiPort}`)
})
