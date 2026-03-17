import type { PvPBotFn } from './pvp-shared.js';
import {
    DRAGON_DAGGER,
    DRAGON_BATTLEAXE,
    MAGIC_SHORTBOW,
    RING_OF_RECOIL,
    SHARK,
    CHOCOLATE_BOMB,
    SUPER_ATTACK4,
    SUPER_STRENGTH4,
    SUPER_DEFENCE4,
    RANGING_POTION4,
    FIGHT_X, FIGHT_Z,
    isBotDead, eatFood, countFood, getHpPercent,
    escapeWithGlory,
    makeTournamentSnapshot,
    findAnyDosePotion, hasPid, kite, hasMeleeSpecEquipped,
    PRAYER_POTION_BASE, RANGING_POTION_BASE,
    SUPER_DEFENCE_BASE, SUPER_STRENGTH_BASE, SUPER_ATTACK_BASE,
} from './pvp-shared.js';

export const botName = 'alpha';

/**
 * Bot Alpha — Ranged-first kiter with DDS/DBA melee switches.
 *
 * State is inferred from the equipped weapon each tick:
 *   - Magic shortbow = ranged mode
 *   - Dragon dagger = DDS spec mode
 *   - Dragon battleaxe = DBA mode
 *
 * Kites during action_delay cooldown (varp 58) — covers attacks and eating.
 * Ranged: kite until 1 tick of cooldown remains (walk back into range).
 * Melee: kite until 2 ticks of cooldown remain.
 * DDS: Only enters when spec energy >= 250. Exits when energy < 250.
 * DBA: Single hit (melee XP gain) then back to MSB.
 */

export const run: PvPBotFn = async (bot, opponentName, coord, isInitiator) => {
    // ═══ SETUP ═══
    bot.restoreFromSnapshot(makeTournamentSnapshot(FIGHT_X, 3492));
    await bot.waitForTicks(2);

    bot.setCombatStyle(1); // Rapid
    bot.player.vars[172] = 1; // Disable auto-retaliate — bot re-engages manually after kiting

    if (bot.findItem(SUPER_ATTACK4))   { await bot.useItemOp1(SUPER_ATTACK4);   await bot.waitForTicks(1); }
    if (bot.findItem(SUPER_STRENGTH4)) { await bot.useItemOp1(SUPER_STRENGTH4); await bot.waitForTicks(1); }
    if (bot.findItem(SUPER_DEFENCE4))  { await bot.useItemOp1(SUPER_DEFENCE4);  await bot.waitForTicks(1); }
    if (bot.findItem(RANGING_POTION4)) { await bot.useItemOp1(RANGING_POTION4); await bot.waitForTicks(1); }

    await bot.pressButton('prayer:prayer_steelskin');          await bot.waitForTicks(1);
    await bot.pressButton('prayer:prayer_ultimatestrength');   await bot.waitForTicks(1);
    await bot.pressButton('prayer:prayer_incrediblereflexes'); await bot.waitForTicks(1);

    await bot.walkToWithPathfinding(FIGHT_X, FIGHT_Z);

    if (isInitiator) coord.botAReady = true;
    else coord.botBReady = true;
    bot.log('STATE', `Alpha ready at (${bot.player.x},${bot.player.z})`);

    for (let i = 0; i < 3000; i++) {
        await bot.waitForTick();
        if (coord.fightStarted) break;
        if (isInitiator ? coord.botBError : coord.botAError) {
            throw new Error(`Opponent error: ${isInitiator ? coord.botBError : coord.botAError}`);
        }
    }
    if (!coord.fightStarted) throw new Error('Alpha: timed out waiting for fight start');

    {
        const target = bot.findNearbyPlayerByUsername(opponentName, 60);
        if (!target) throw new Error(`Alpha: cannot find opponent ${opponentName}`);
        if (!bot.reEngagePlayer(target)) throw new Error(`Alpha: failed to engage ${opponentName}`);
    }

    // ═══ CROSS-TICK STATE ═══
    // These persist across ticks because they track deltas or history
    // that cannot be recomputed from current game state alone.

    // Previous tick's ranged XP — needed to compute XP gain delta for big-hit detection (triggers melee switch)
    let prevRangedXp = bot.getSkill('RANGED').exp;
    // action_delay value when DBA was equipped — needed to detect when the DBA attack fires
    // (action_delay changes to a new value). Can't recompute because current action_delay could be from any weapon.
    let dbaEntryDelay = 0;
    // Previous tick's ring charge — needed to detect ring shatter (charge drops from >=20 to 0)
    let prevRingCharge = 0;
    // Once-only flag — after the first ring shatters, equip the spare. Can't recompute because having a spare ring in inventory doesn't tell us if the worn one already broke.
    let ringShattered = false;
    // Consecutive ticks with 0 food — drives escape decision. Reset when food appears. Can't recompute because it's a duration.
    let ticksWithoutFood = 0;
    // Previous tick's opponent HP — needed to detect opponent eating (HP increases between ticks). Can't recompute because we don't store HP history.
    let prevOpponentHp = 99;

    // ═══ TICK FUNCTION ═══
    async function combatTick(tick: number): Promise<boolean> {
        bot.dismissModals();

        // ─── GAME STATE (read fresh from engine) ───
        const dead = isBotDead(bot);
        const opponentDead = isInitiator ? coord.botBDead : coord.botADead;
        const opponentEscaped = isInitiator ? coord.botBEscaped : coord.botAEscaped;
        const opponentError = isInitiator ? coord.botBError : coord.botAError;

        const currentHp = bot.getHealth().current;
        const hpPercent = getHpPercent(bot);
        const prayerPoints = bot.player.levels[5] ?? 0;

        const currentRangedXp = bot.getSkill('RANGED').exp;
        const specEnergy = bot.getSpecialEnergy();

        const weapon = bot.getEquippedWeaponName();
        const isRanged = weapon.includes('shortbow');
        const isDds = weapon.includes('dagger');
        const isDba = weapon.includes('battleaxe');

        const opponentPlayer = bot.findNearbyPlayerByUsername(opponentName, 60);
        const opponentHp = opponentPlayer ? (opponentPlayer as any).levels?.[3] ?? 99 : 99;
        const opponentMeleeSpec = opponentPlayer != null && hasMeleeSpecEquipped(opponentPlayer);
        const eatBoost = opponentMeleeSpec ? 10 : 0;

        const foodCount = countFood(bot);
        const hasShark = bot.findItem(SHARK) !== null;
        const hasBomb = bot.findItem(CHOCOLATE_BOMB) !== null;
        const hasMsb = bot.findItem(MAGIC_SHORTBOW) !== null;
        const hasRing = bot.findItem(RING_OF_RECOIL) !== null;

        const ringCharge = bot.player.vars[290] ?? 0;
        const steelskinActive = (bot.player.vars[92] ?? 0) !== 0;
        const ultStrActive = (bot.player.vars[93] ?? 0) !== 0;
        const incRefActive = (bot.player.vars[94] ?? 0) !== 0;
        const hasTarget = bot.player.target !== null;

        // PID: lower player slot processes first — if bot has PID, its hit lands
        // before the opponent can eat. Influences risk tolerance and finishing decisions.
        const botHasPid = opponentPlayer != null && hasPid(bot, opponentPlayer);

        const prayerPot = findAnyDosePotion(bot, PRAYER_POTION_BASE);

        // Find the lowest-dose combat pot for eat-tick rotation
        let bestCombatPot: string | null = null;
        {
            let bestDose = 5;
            for (const base of [RANGING_POTION_BASE, SUPER_DEFENCE_BASE, SUPER_STRENGTH_BASE, SUPER_ATTACK_BASE]) {
                for (const dose of [1, 2, 3, 4]) {
                    const name = `${base}(${dose})`;
                    if (bot.findItem(name)) {
                        if (dose < bestDose) { bestCombatPot = name; bestDose = dose; }
                        break;
                    }
                }
            }
        }

        // ─── ACTION DELAY — kite/re-engage derived from engine cooldown ───
        // Varp 58 (action_delay) is set by ALL combat scripts (melee, ranged, magic, spec)
        // and by food consumption. It represents "next action available at tick N".
        const actionDelay = bot.player.vars[58] ?? 0;
        const currentTick = bot.getCurrentTick();
        const cooldownRemaining = Math.max(0, actionDelay - currentTick);
        // Bot reads action_delay 1 tick late (processBotInput runs before processPlayers
        // sets it), so offset stopKiteAt by -1 to compensate.
        // Ranged: kite until 0 ticks left. Melee: kite until 1 tick left.
        const stopKiteAt = isRanged ? 0 : 1;
        const shouldKite = cooldownRemaining > stopKiteAt;
        const canReengage = !shouldKite && opponentPlayer != null && !hasTarget;

        // ─── DELTAS (require cross-tick comparison) ───
        const rangedXpGain = currentRangedXp - prevRangedXp;
        const bigRangedHit = rangedXpGain >= 40;
        const ringJustShattered = !ringShattered && prevRingCharge >= 20 && ringCharge === 0;
        const opponentAte = opponentHp > prevOpponentHp;

        // Update cross-tick state for next tick
        prevRangedXp = currentRangedXp;
        prevRingCharge = ringCharge;
        prevOpponentHp = opponentHp;
        if (ringJustShattered) ringShattered = true;
        if (foodCount === 0) ticksWithoutFood++;
        else ticksWithoutFood = 0;

        // ─── DERIVED STATE ───
        // Only skip eating to go for a kill if bot HP is safe from a single max hit (~20 for MSB)
        const riskIt = currentHp > 25 && opponentHp < 15 && botHasPid;
        const prayerEmergency = prayerPoints < 10;
        // Switch to melee on a big ranged hit, OR randomly rush DDS when opponent is low
        const ddsRush = isRanged && specEnergy >= 250 && opponentHp < 34 && opponentPlayer != null && Math.random() < 0.10;
        const shouldSwitchToMelee = isRanged && opponentPlayer != null && (ddsRush || (bigRangedHit && opponentHp < 45));
        const shouldExitDds = isDds && (specEnergy < 250 || opponentHp >= 50 || opponentAte);
        const shouldExitDba = isDba && (actionDelay !== dbaEntryDelay || opponentAte);
        const shouldEscape = foodCount === 0 && (ticksWithoutFood >= 60 || hpPercent <= 15);

        // ─── ACTIONS (all decisions use state variables above) ───

        // Exit conditions
        if (dead) {
            if (isInitiator) coord.botADead = true;
            else coord.botBDead = true;
            return false;
        }
        if (opponentDead) return false;
        if (opponentEscaped) return false;
        if (opponentError) throw new Error(`Opponent error: ${opponentError}`);

        // DDS spec re-arm
        if (isDds && specEnergy >= 250) {
            bot.enableSpecialAttack(true);
        }

        // Prayer emergency
        if (prayerEmergency) {
            if (prayerPot) {
                await bot.useItemOp1(prayerPot);
            } else {
                bot.log('STATE', `Alpha: PRAYER EMERGENCY — no pots, teleporting at tick ${tick}`);
                if (await escapeWithGlory(bot, coord, isInitiator)) return false;
            }
        }

        // Kite during action cooldown
        if (shouldKite) {
            doKite(tick, `cooldown (${cooldownRemaining} ticks left)`);
        }

        // Weapon transitions
        if (shouldSwitchToMelee) {
            if (specEnergy >= 250 && Math.random() < 0.6) {
                await bot.equipItemWithSpec(DRAGON_DAGGER);
                bot.log('STATE', `Alpha: →DDS at tick ${tick} (spec=${specEnergy})`);
            } else {
                await bot.equipItem(DRAGON_BATTLEAXE);
                dbaEntryDelay = actionDelay;
                bot.log('STATE', `Alpha: →DBA at tick ${tick}`);
            }
            bot.setCombatStyle(1);
            if (opponentPlayer) bot.reEngagePlayer(opponentPlayer);
        } else if (shouldExitDds) {
            bot.enableSpecialAttack(false);
            if (hasMsb) await bot.equipItem(MAGIC_SHORTBOW);
            bot.setCombatStyle(1);
            bot.log('STATE', `Alpha: DDS→ranged at tick ${tick}`);
        } else if (shouldExitDba) {
            if (hasMsb) await bot.equipItem(MAGIC_SHORTBOW);
            bot.setCombatStyle(1);
            bot.log('STATE', `Alpha: DBA→ranged at tick ${tick}`);
        }

        // Eating (after kite + weapon switch — eating adds to action_delay so do it last)
        if (!riskIt) {
            if (currentHp <= 15 + eatBoost) {
                if (hasShark) {
                    await eatFood(bot, SHARK);
                    if (hasBomb) { await eatFood(bot, CHOCOLATE_BOMB); }
                } else if (hasBomb) {
                    await eatFood(bot, CHOCOLATE_BOMB);
                }
            } else if (currentHp <= 30 + eatBoost) {
                if (hasShark) {
                    await eatFood(bot, SHARK);
                    await bot.waitForTicks(1);
                    const followUpPot = prayerPoints < 40 ? prayerPot : bestCombatPot;
                    if (followUpPot) await bot.useItemOp1(followUpPot);
                } else if (hasBomb) {
                    await eatFood(bot, CHOCOLATE_BOMB);
                }
            }
        }

        // Prayer maintenance
        if (!steelskinActive) { try { await bot.pressButton('prayer:prayer_steelskin'); } catch { /* combat delay */ } }
        if (!ultStrActive) { try { await bot.pressButton('prayer:prayer_ultimatestrength'); } catch { /* combat delay */ } }
        if (!incRefActive) { try { await bot.pressButton('prayer:prayer_incrediblereflexes'); } catch { /* combat delay */ } }

        // Re-engage when cooldown allows (non-blocking — attackPlayer blocks for 15 ticks)
        if (canReengage) {
            bot.reEngagePlayer(opponentPlayer!);
        }

        // Ring of recoil spare
        if (ringJustShattered && hasRing) {
            try { await bot.equipItem(RING_OF_RECOIL); } catch { /* combat delay */ }
        }

        // Escape
        if (shouldEscape) {
            bot.log('STATE', `Alpha: ESCAPING (foodless=${ticksWithoutFood}, hpPct=${Math.round(hpPercent)})`);
            if (await escapeWithGlory(bot, coord, isInitiator)) return false;
        }

        return true;
    }

    /** Kite to a random tile and say "kite N". */
    function doKite(tick: number, reason: string): boolean {
        if (!bot.findNearbyPlayerByUsername(opponentName, 60)) return false;
        if (kite(bot)) {
            bot.log('STATE', `Alpha: kite at tick ${tick} (${reason})`);
            return true;
        }
        return false;
    }

    // ═══ COMBAT LOOP ═══
    const MAX_TICKS = 2000;
    for (let tick = 0; tick < MAX_TICKS; tick++) {
        await bot.waitForTick();
        if (!await combatTick(tick)) return;
    }

    bot.log('STATE', 'Alpha: reached MAX_TICKS — exiting as draw');
    if (isInitiator) coord.botAEscaped = true;
    else coord.botBEscaped = true;
};
