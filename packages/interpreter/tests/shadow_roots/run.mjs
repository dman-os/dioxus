// Loads the harness page in a Playwright engine and prints its report; exits non-zero unless it ends in `DONE OK`.
// Usage: node run.mjs <chromium|webkit> <url>   (PLAYWRIGHT_CORE = path of the playwright-core package)
import { createRequire } from "node:module";
const { webkit, chromium } = createRequire(`${process.env.PLAYWRIGHT_CORE}/`)(process.env.PLAYWRIGHT_CORE);
const [, , engine, url] = process.argv;
const browser = await { webkit, chromium }[engine].launch();
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.stack || e));
await page.goto(url);
await page.waitForFunction(() => document.getElementById("out").textContent.includes("DONE"));
const report = await page.evaluate(() => document.getElementById("out").textContent);
console.log(report);
await browser.close();
process.exit(report.trimEnd().endsWith("DONE OK") ? 0 : 1);
