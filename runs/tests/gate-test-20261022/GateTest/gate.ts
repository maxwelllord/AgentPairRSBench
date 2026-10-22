import { runScript } from '../../sdk/runner';

await runScript(async ({ bot, sdk }) => {
    await bot.skipTutorial();
    const pos = () => { const p = sdk.getState()!.player; return `(${p.worldX}, ${p.worldZ})`; };
    console.log('start', pos());
    console.log('walk west of gate', JSON.stringify(await bot.walkTo(3266, 3227, 1, { timeout: 60_000 })), pos());
    const gate = sdk.findNearbyLoc(/^gate$/i);
    console.log('gate', gate && `${gate.name} at (${gate.x}, ${gate.z})`, gate?.options);
    console.log('open', JSON.stringify(await bot.openDoor(gate!)));
    await sdk.waitForTicks(6);
    console.log('after open', pos(), 'dialog open:', sdk.getState()!.dialog.isOpen);
    console.log('walk to Al Kharid', JSON.stringify(await bot.walkTo(3290, 3190, 2, { timeout: 60_000 })), pos());
    console.log('walk back to Lumbridge', JSON.stringify(await bot.walkTo(3235, 3220, 2, { timeout: 90_000 })), pos());
    console.log('dialog open at end:', sdk.getState()!.dialog.isOpen);
}, { timeout: 240_000 });
