// Headless browser game client that also records: an alternative to the lite
// runner for runs started with --record. Keeps the bot logged in and writes a
// JPEG of the game canvas every interval to <outDir>/frame-NNNNN.jpg, plus
// <outDir>/latest.jpg for live viewing.
//
//   bun bench/browser-client.ts <bot> <password> <outDir> [intervalSec=2]

import puppeteer from '../rs-sdk/node_modules/puppeteer';
import { mkdirSync, copyFileSync } from 'fs';
import { join } from 'path';

const [bot, password, outDir, intervalArg] = process.argv.slice(2);
const intervalMs = parseFloat(intervalArg ?? '2') * 1000;
const origin = process.env.GAME_ORIGIN ?? 'http://localhost:8888';
mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--window-size=765,503']
});
const page = await browser.newPage();
await page.setViewport({ width: 765, height: 503 });
await page.goto(`${origin}/bot?bot=${encodeURIComponent(bot)}&password=${encodeURIComponent(password)}&fps=15&minimal`, { waitUntil: 'networkidle2', timeout: 60_000 });

const loginDeadline = Date.now() + 60_000;
while (!(await page.evaluate(() => (window as any).gameClient?.ingame))) {
    if (Date.now() > loginDeadline) {
        console.error('Timed out waiting for the browser client to log in');
        process.exit(1);
    }
    await new Promise(r => setTimeout(r, 250));
}
console.log(`INGAME ${bot}`);

let n = 0;
for (;;) {
    const t0 = Date.now();
    const file = join(outDir, `frame-${String(n++).padStart(5, '0')}.jpg`);
    try {
        await page.screenshot({ path: file, type: 'jpeg', quality: 70 });
        copyFileSync(file, join(outDir, 'latest.jpg'));
    } catch (err) {
        console.error(`screenshot failed: ${err}`);
    }
    await new Promise(r => setTimeout(r, Math.max(0, intervalMs - (Date.now() - t0))));
}
