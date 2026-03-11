import { BotAPI } from '../runtime/api.js';
import { skipTutorial } from './skip-tutorial.js';

const MEN_X = 3222;
const MEN_Z = 3218;
const TARGET_LEVEL = 5;
const PICKPOCKET_OP = 3;

// Varp IDs from content/pack/varp.pack
const VARP_ACTION_DELAY = 58;
const VARP_STUNNED = 103;

export async function thievingMen(bot: BotAPI): Promise<void> {
    // Step 1: Skip tutorial to get to Lumbridge
    await skipTutorial(bot);
    await bot.waitForTicks(2);

    // Step 2: Walk near Men NPCs in Lumbridge
    await bot.walkTo(MEN_X, MEN_Z);
    bot.log('STATE', `Arrived near Men area at (${bot.player.x},${bot.player.z})`);

    // Step 3: Pickpocket loop until Thieving >= 5
    let attempts = 0;
    let successes = 0;
    let failures = 0;

    while (bot.getSkill('Thieving').level < TARGET_LEVEL) {
        // Dismiss any open modal interface (e.g. level-up dialog).
        // The level-up script opens a chat modal with p_pausebutton which blocks
        // all interactions until dismissed.
        bot.dismissModals();

        // Wait until stun and action_delay varps have expired.
        // The RS2 pickpocket script sets %stunned and %action_delay to map_clock + 8 on failure.
        // The walktrigger(stunned) cancels all movement while %stunned > map_clock.
        const stunnedUntil = bot.getVarp(VARP_STUNNED);
        const actionDelayUntil = bot.getVarp(VARP_ACTION_DELAY);
        const currentTick = bot.getCurrentTick();

        if (stunnedUntil > currentTick || actionDelayUntil > currentTick) {
            const waitUntil = Math.max(stunnedUntil, actionDelayUntil);
            const ticksToWait = waitUntil - currentTick + 1;
            bot.log('STATE', `Stunned/delayed, waiting ${ticksToWait} ticks`);
            await bot.waitForTicks(ticksToWait);
        }

        // Also wait for engine-level delay to clear (p_delay)
        if (bot.player.delayed) {
            await bot.waitForCondition(() => !bot.player.delayed, 20);
        }

        // Find a nearby Man NPC
        let man = bot.findNearbyNpc('Man');
        if (!man) {
            bot.log('STATE', `No Man found nearby, walking to (${MEN_X},${MEN_Z})`);
            await bot.walkTo(MEN_X, MEN_Z);
            await bot.waitForTicks(2);
            man = bot.findNearbyNpc('Man');
            if (!man) {
                throw new Error(`No Man NPC found near (${MEN_X},${MEN_Z}) after walking there`);
            }
        }

        attempts++;
        const expBefore = bot.getSkill('Thieving').exp;

        // Set interaction - engine will auto-walk to NPC and execute pickpocket
        await bot.interactNpc(man, PICKPOCKET_OP);

        // Wait for the pickpocket action to resolve.
        await bot.waitForTicks(5);

        const expAfter = bot.getSkill('Thieving').exp;
        if (expAfter > expBefore) {
            successes++;
            bot.log('EVENT', `Pickpocket SUCCESS (attempt ${attempts}, xp=${expAfter})`);

            // Wait 1 tick then dismiss modals. The stat_advance during the pickpocket
            // enqueues an advancestat script in the engine queue. It fires on the NEXT
            // tick (processEngineQueue runs before processInteraction). We must wait for
            // it to fire, then dismiss the level-up dialog before the next interaction.
            await bot.waitForTicks(1);
            bot.dismissModals();
        } else {
            failures++;
            bot.log('EVENT', `Pickpocket FAIL/STUN (attempt ${attempts}, xp=${expAfter})`);
        }
    }

    const skill = bot.getSkill('Thieving');
    bot.log('SUCCESS', `Thieving level ${skill.level} reached! xp=${skill.exp} attempts=${attempts} successes=${successes} failures=${failures}`);
}
