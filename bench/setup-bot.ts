// Brings a freshly created bot to the common starting state: tutorial skipped,
// standing in Lumbridge with the starter kit. Credentials come from env vars
// (BOT_USERNAME, PASSWORD, SERVER, GATEWAY_URL) set by run.ts.
import { runScript } from '../rs-sdk/sdk/runner';

// Tutorial Island bounds (same as rs-bench's launch-bot.ts).
const onTutorialIsland = (x: number, z: number) => x >= 3050 && x <= 3156 && z >= 3056 && z <= 3136;

await runScript(async ({ bot, sdk }) => {
    // State can arrive before stats/inventory do (HP 0/0); skipping then silently does nothing.
    await sdk.waitForCondition(s => (s.player?.maxHp ?? 0) > 0, 30_000);

    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
        const p = sdk.getState()?.player;
        if (p && !onTutorialIsland(p.worldX, p.worldZ)) break;
        await Promise.race([bot.skipTutorial(), new Promise(r => setTimeout(r, 10_000))]);
        await new Promise(r => setTimeout(r, 1000));
    }

    const p = sdk.getState()?.player;
    if (!p || onTutorialIsland(p.worldX, p.worldZ)) {
        console.log(`STUCK ${p?.worldX},${p?.worldZ}`);
        return;
    }
    console.log(`READY ${p.worldX},${p.worldZ} cb=${p.combatLevel} hp=${p.maxHp}`);
}, {
    timeout: 150_000
});
