// Renders the background for a run's map timelapse: the engine's own world map (/mapview),
// framed around every position in runs/<run>/positions.jsonl, plus the tile -> pixel mapping.
//   bun bench/map-base.ts runs/<run> [width height]  ->  <run>/map-base.png + map-base.json
// Needs the engine up (port 8888). The served map script is patched in this headless browser
// only, to expose the MapView instance; no live players or history traces are drawn.
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import puppeteer from '../rs-sdk/node_modules/puppeteer';

const runDir = process.argv[2];
const W = parseInt(process.argv[3] ?? '1920');
const H = parseInt(process.argv[4] ?? '1080');
const UI = 48; // the map draws its zoom/key/overview buttons along the bottom edge; render taller and crop
if (!runDir) throw new Error('usage: bun bench/map-base.ts runs/<run> [width height]');

const points: Array<{ x: number; z: number }> = [];
for (const line of readFileSync(join(runDir, 'positions.jsonl'), 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    // Dungeons are stored 6400 tiles north of the surface above them (Varrock sewers under Varrock).
    for (const p of JSON.parse(line).players) points.push({ x: p.x, z: p.z >= 6400 ? p.z - 6400 : p.z });
}
if (!points.length) throw new Error('no positions recorded');

const browser = await puppeteer.launch({ headless: true, args: ['--disable-gpu'] });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: W, height: H + UI, deviceScaleFactor: 1 });
    await page.setRequestInterception(true);
    page.on('request', async req => {
        const path = new URL(req.url()).pathname;
        if (path === '/playerpositions') return req.respond({ status: 200, contentType: 'application/json', body: '[]' });
        if (path === '/playertraces') return req.respond({ status: 404, body: '' });
        if (path === '/client/mapview.js') {
            const src = await (await fetch(req.url())).text();
            const hooked = src.replace(/this\.playerPositions=(\w+),/, 'window.__mv=this,this.playerPositions=$1,');
            if (hooked === src) console.error('warning: map script hook not found');
            return req.respond({ status: 200, contentType: 'application/javascript', body: hooked });
        }
        req.continue();
    });
    await page.goto('http://localhost:8888/mapview', { waitUntil: 'networkidle0' });
    await page.waitForFunction('window.__mv && window.__mv.sWid > 0', { timeout: 30_000 });

    const view = await page.evaluate((pts: Array<{ x: number; z: number }>, W: number, H: number) => {
        const mv = (window as any).__mv;
        const MV = mv.constructor;
        MV.shouldDrawPlayers = false;
        MV.shouldDrawHistory = false;
        mv.showKey = false;
        mv.showOverview = false;
        // Same projection as MapView.drawPlayers: unified map column/row of a world tile.
        const mapPts = pts.map(p => ({ x: p.x - mv.mapOriginX, y: mv.mapOriginZ + mv.mapHeight - mv.remapZ(p.z), ok: mv.remapZ(p.z) !== -1 })).filter(p => p.ok);
        let x0 = Math.min(...mapPts.map(p => p.x)), x1 = Math.max(...mapPts.map(p => p.x));
        let y0 = Math.min(...mapPts.map(p => p.y)), y1 = Math.max(...mapPts.map(p => p.y));
        const margin = 25;
        let spanX = Math.max(x1 - x0 + 2 * margin, 100), spanY = Math.max(y1 - y0 + 2 * margin, 100 * H / W);
        if (spanX / spanY < W / H) spanX = spanY * W / H; else spanY = spanX * H / W;
        // The view spans 2*sWid/zoom map tiles across (mainredraw), so zoom = 2*sWid/span.
        const zoom = Math.max(1.5, Math.min(16, (2 * mv.sWid) / spanX));
        mv.zoom = mv.targetZoom = zoom;
        mv.focusX = Math.round((x0 + x1) / 2);
        mv.focusZ = Math.round((y0 + y1) / 2 + (mv.sHei - H) / zoom); // centre within the cropped top H rows
        mv.redraw = true;
        return { zoom, focusX: mv.focusX, focusZ: mv.focusZ };
    }, points, W, H);

    await new Promise(r => setTimeout(r, 3000)); // the map blits to the canvas every 50 frames
    const map = await page.evaluate(() => {
        const mv = (window as any).__mv;
        const left = mv.focusX - ((mv.sWid / mv.zoom) | 0), right = mv.focusX + ((mv.sWid / mv.zoom) | 0);
        const top = mv.focusZ - ((mv.sHei / mv.zoom) | 0), bottom = mv.focusZ + ((mv.sHei / mv.zoom) | 0);
        return { left, right, top, bottom, sWid: mv.sWid, sHei: mv.sHei, mapOriginX: mv.mapOriginX, mapOriginZ: mv.mapOriginZ, mapHeight: mv.mapHeight, bands: mv.constructor.MAP_BANDS };
    });
    // Read the map canvas directly: headless page screenshots started coming back all black (on
    // 2026-10-22) while the canvas itself was drawn fine.
    const png = await page.evaluate((W: number, H: number) => {
        const src = document.querySelector('canvas') as HTMLCanvasElement;
        const crop = document.createElement('canvas');
        crop.width = W;
        crop.height = H;
        crop.getContext('2d')!.drawImage(src, 0, 0, W, H, 0, 0, W, H);
        return crop.toDataURL('image/png').split(',')[1]!;
    }, W, H);
    writeFileSync(join(runDir, 'map-base.png'), Buffer.from(png, 'base64'));
    writeFileSync(join(runDir, 'map-base.json'), JSON.stringify({ ...view, ...map, width: W, height: H }, null, 2));
    console.log(join(runDir, 'map-base.png'));
} finally {
    await browser.close();
}
