
const { Highrise, Events, WebApi, Collection } = require('highrise.sdk.dev');
const colors = require('colors'); // This line is crucial for colored console output
const fs = require('fs').promises; // For file operations (async)
const { v4: uuidv4 } = require('uuid'); // For generating unique IDs
const axios = require('axios'); // For OpenRouter API
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => {
  res.send("Bot is alive!");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  client.connect();
});
// --- Configuration & Data Loading ---
let config;
let permissions;
let bannedUsers;
let mutedUsers;
let badWords;
let userLastSeen;
let botLastSetLocation; // To persist !setbot location
let frozenUsers; // To persist frozen users and their locked positions
let messages; // For user-facing response messages

// Load JSON files
async function loadJson(filePath) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            logEvent('warning', `File not found: ${filePath}. Creating with default empty object.`);
            await saveJson(filePath, {});
            return {};
        }
        logEvent('error', `Error loading ${filePath}: ${error.message}`);
        return {};
    }
}

// Save JSON files
async function saveJson(filePath, data) {
    try {
        await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
        // logEvent('debug', `Saved ${filePath}`); // Commented to reduce verbosity
    } catch (error) {
        logEvent('error', `Error saving ${filePath}: ${error.message}`);
    }
}

async function loadAllConfigs() {
    config = await loadJson('config.json');
    permissions = await loadJson(config.permissionFiles.roles);
    bannedUsers = await loadJson(config.permissionFiles.bannedCommands);
    mutedUsers = await loadJson(config.permissionFiles.mutedMessages);
    badWords = await loadJson(config.permissionFiles.badWords);
    userLastSeen = await loadJson(config.permissionFiles.userLastSeen);
    messages = await loadJson(config.messagesFile);
    
    // Load botLocation.json, if empty, use default from config
    let loadedBotLocation = await loadJson(config.permissionFiles.botLocation);
    if (Object.keys(loadedBotLocation).length === 0) {
        botLastSetLocation = config.defaultBotLocation;
        await saveJson(config.permissionFiles.botLocation, botLastSetLocation);
    } else {
        botLastSetLocation = loadedBotLocation;
    }

    // Load frozenUsers.json, if empty, use default empty object
    let loadedFrozenUsers = await loadJson(config.permissionFiles.frozenUsers);
    if (Object.keys(loadedFrozenUsers).length === 0) {
        frozenUsers = { "locked": {} }; // Ensure the structure is { "locked": {} }
        await saveJson(config.permissionFiles.frozenUsers, frozenUsers);
    } else {
        frozenUsers = loadedFrozenUsers;
    }
}

// --- Logging Utility (Colored output) ---
function logEvent(type, message, ...args) {
    if (!config || !config.consoleColors) return console.log(`[${type}] ${message}`, ...args); // Fallback

    const color = config.consoleColors[type] || 'white';
    // Check if colors.js actually provides the specified color method
    if (colors[color] && typeof colors[color] === 'function') {
        const formattedMessage = typeof message === 'string' ? message.replace(/\n\s*/g, ' ') : message; // Remove newlines from single line log
        console.log(`[${type.toUpperCase()}]`[color] + ` ${formattedMessage}`[color], ...args);
    } else {
        // Fallback if color method doesn't exist
        console.log(`[${type.toUpperCase()}] ${message}`, ...args);
    }
}

// --- Permissions & Moderation Helpers ---
function getRole(userId) {
    if (permissions.owners.includes(userId)) return 'owner';
    if (permissions.mods.includes(userId)) return 'mod';
    return 'basic';
}

function hasPermission(userId, requiredRole) {
    const userRole = getRole(userId);
    if (requiredRole === 'basic') return true;
    if (requiredRole === 'mod' && (userRole === 'mod' || userRole === 'owner')) return true;
    if (requiredRole === 'owner' && userRole === 'owner') return true;
    return false;
}

function isBanned(userId) {
    const banInfo = bannedUsers.users[userId];
    if (!banInfo) return false;
    if (banInfo.duration_minutes) {
        const banTime = new Date(banInfo.timestamp);
        const now = new Date();
        const elapsedMinutes = (now.getTime() - banTime.getTime()) / (1000 * 60);
        if (elapsedMinutes > banInfo.duration_minutes) {
            delete bannedUsers.users[userId];
            saveJson(config.permissionFiles.bannedCommands, bannedUsers);
            return false;
        }
    }
    return true;
}

function isMuted(userId) {
    const muteInfo = mutedUsers.users[userId];
    if (!muteInfo) return false;
    const muteTime = new Date(muteInfo.timestamp);
    const now = new Date();
    const elapsedMinutes = (now.getTime() - muteTime.getTime()) / (1000 * 60);
    if (elapsedMinutes > muteInfo.duration_minutes) {
        delete mutedUsers.users[userId];
        saveJson(config.permissionFiles.mutedMessages, mutedUsers);
        return false;
    }
    return true;
}

function addBadWord(word) {
    const lowerCaseWord = word.toLowerCase();
    if (!badWords.words.includes(lowerCaseWord)) {
        badWords.words.push(lowerCaseWord);
        saveJson(config.permissionFiles.badWords, badWords);
        return true;
    }
    return false;
}

function removeBadWord(word) {
    const initialLength = badWords.words.length;
    const lowerCaseWord = word.toLowerCase();
    badWords.words = badWords.words.filter(w => w !== lowerCaseWord);
    if (badWords.words.length < initialLength) {
        saveJson(config.permissionFiles.badWords, badWords);
        return true;
    }
    return false;
}

function containsBadWord(message) {
    const lowerCaseMessage = message.toLowerCase();
    for (const word of badWords.words) {
        if (lowerCaseMessage.includes(word)) {
            return true;
        }
    }
    return false;
}

// --- Bot Instance ---
let bot;
let emoteLoops = new Map(); // userId -> { timeoutId, emoteId, duration }

// --- Main Function ---
async function main() {
    await loadAllConfigs();

    bot = new Highrise({
        Events: [
            Events.Messages,
            Events.DirectMessages,
            Events.Joins,
            Events.Leaves,
            Events.Reactions,
            Events.Emotes,
            Events.Tips,
            Events.VoiceChat,
            Events.Movements,
            Events.Moderate
        ],
        Cache: true, // Enable caching for player movements
        AutoFetchMessages: true // Fetch message content for DMs
    });

    // --- Event Handlers ---
    bot.on('ready', async (session) => {
        logEvent('success', `Bot is ready! Connected to room: ${session.room_info.room_name} (${config.botAuth.roomId})`);
        logEvent('info', `Bot User ID: ${session.user_id}`);
        logEvent('info', `Room Owner ID: ${session.room_info.owner_id}`);

        // Go to default set location
        try {
            // Ensure bot's own ID is set before proceeding
            if (!bot.info.user.id) bot.info.user.id = session.user_id;

            await bot.player.teleport(bot.info.user.id, botLastSetLocation.x, botLastSetLocation.y, botLastSetLocation.z, botLastSetLocation.facing);
            logEvent('botAction', `Bot moved to its set location.`);
        } catch (error) {
            logEvent('error', `Failed to move bot to set location: ${error.message}`);
        }

        // Start auto-emote feature
        if (config.features.autoEmote.enabled) {
            setInterval(async () => {
                if (!bot.info.user.id) return; // Ensure bot user ID is set
                const selectedEmotes = Object.values(config.emoteDefinitions)
                    .filter(e => e.id) // Only use emotes with an ID
                    .sort(() => 0.5 - Math.random()) // Randomize
                    .slice(0, config.features.autoEmote.emoteCount);

                for (const emote of selectedEmotes) {
                    try {
                        await bot.player.emote(bot.info.user.id, emote.id);
                        logEvent('debug', `Bot performed auto-emote: ${emote.id}`);
                        await new Promise(resolve => setTimeout(resolve, 3000)); // Small delay between emotes
                    } catch (e) {
                        logEvent('error', `Failed to perform auto-emote ${emote.id}: ${e.message}`);
                    }
                }
            }, config.features.autoEmote.intervalSeconds * 1000); // Convert seconds to milliseconds
            logEvent('info', `Auto-emote feature enabled, every ${config.features.autoEmote.intervalSeconds} seconds.`);
        }
    });

    bot.on('playerJoin', async (user, position) => {
        logEvent('playerJoin', `${user.username} (${user.id}) joined at X:${position.x}, Y:${position.y}, Z:${position.z}`);

        if (config.features.autoGreeting.enabled && user.id !== bot.info.user.id) {
            const now = new Date();
            if (userLastSeen[user.id]) {
                const lastSeenTime = new Date(userLastSeen[user.id]);
                const formattedLastSeen = lastSeenTime.toLocaleString();
                const greetingMessage = config.features.autoGreeting.message
                    .replace('{}', user.username)
                    .replace('{}', formattedLastSeen);
                await bot.message.send(greetingMessage);
                logEvent('botAction', `Greeted ${user.username} (returning user).`);
            } else {
                await bot.message.send(config.features.autoGreeting.firstTimeMessage.replace('{}', user.username));
                logEvent('botAction', `Greeted ${user.username} (new user).`);
            }
            userLastSeen[user.id] = now.toISOString();
            await saveJson(config.permissionFiles.userLastSeen, userLastSeen);
        }
    });

    bot.on('playerLeave', async (user) => {
        logEvent('playerLeave', `${user.username} (${user.id}) left the room.`);
        // Stop any ongoing emote loops for the leaving user
        if (emoteLoops.has(user.id)) {
            clearTimeout(emoteLoops.get(user.id).timeoutId);
            emoteLoops.delete(user.id);
            logEvent('debug', `Stopped emote loop for ${user.username}.`);
        }
    });

    bot.on('chatCreate', async (user, message) => {
        logEvent('chatMessage', `[PUBLIC CHAT] ${user.username} (${user.id}): ${message}`);

        if (user.id === bot.info.user.id) return; // Ignore bot's own messages

        // Mute/Ban check for bot commands
        if (isMuted(user.id)) {
            logEvent('debug', `${user.username} is muted, ignoring message.`);
            return;
        }
        if (isBanned(user.id)) {
            logEvent('debug', `${user.username} is command-banned, ignoring message.`);
            return;
        }

        // Bad word check
        if (containsBadWord(message)) {
            await bot.message.send(`@${user.username} Warning: You used a forbidden word. Please refrain from using such language.`);
            logEvent('badWordAlert', `Bad word alert from ${user.username}: "${message}"`);
            return;
        }

        const lowerCaseMessage = message.toLowerCase();

        // --- 'emotename' @username (no prefix) for single emote ---
        // Pattern: word @another_word (e.g., "slap @Rajpurohite")
        const emoteRegex = /^(\w+)\s+@(\w+)$/;
        const match = lowerCaseMessage.match(emoteRegex);
        if (match) {
            const emoteCommand = match[1]; // e.g., "slap"
            const targetUsername = match[2]; // e.g., "rajpurohite"

            const emoteDef = config.emoteDefinitions[emoteCommand];
            if (emoteDef) { // Check if it's a recognized emote
                try {
                    const targetUserObj = await bot.room.players.get().then(players => {
                        const found = players.find(([pUser]) => pUser.username.toLowerCase() === targetUsername);
                        return found ? found[0] : null;
                    });

                    if (targetUserObj) {
                        // This specific command implies basic permission, as per request
                        if (hasPermission(user.id, 'basic')) {
                            await handleSingleEmoteCommand(targetUserObj.id, emoteCommand);
                            // The command is handled, so return
                            return;
                        } else {
                            await bot.message.send(`@${user.username} You do not have permission to emote others.`);
                            return;
                        }
                    }
                } catch (e) {
                     logEvent('error', `Error processing 'emotename @username': ${e.message}`);
                }
            }
        }


        // Handle emotes without prefix for loop (e.g., just "laidback") - specific public chat feature
        for (const emoteName in config.emoteDefinitions) {
            if (lowerCaseMessage === emoteName.toLowerCase()) {
                await handleEmoteLoopCommand(user, emoteName);
                return;
            }
        }

        // If not a command, it's not handled in public chat unless it's a specific emote word.
        if (!lowerCaseMessage.startsWith(config.botPrefix)) {
            logEvent('debug', `Public chat message from ${user.username} not starting with prefix or recognized as a direct emote name. Ignored.`);
            return;
        }

        // Process commands with prefix
        const args = message.slice(config.botPrefix.length).trim().split(/ +/);
        const command = args.shift().toLowerCase();
        const targetUsernameArg = args[0] && args[0].startsWith('@') ? args[0].substring(1) : null;
        let targetUserId = null;
        if (targetUsernameArg) {
            try {
                targetUserId = await bot.room.players.id(targetUsernameArg);
                 if (!targetUserId) {
                    await bot.message.send(`@${user.username} User '${targetUsernameArg}' not found in the room.`);
                    logEvent('warning', `Target user '${targetUsernameArg}' not found for command ${command}.`);
                    return;
                }
            } catch (e) {
                await bot.message.send(`@${user.username} Error finding target user '${targetUsernameArg}'.`);
                logEvent('error', `Error finding target user '${targetUsernameArg}': ${e.message}`);
                return;
            }
        }
       
        logEvent('commandLog', `Processing command from ${user.username} (${user.id}): ${message}`);

        // Check if command is allowed in Public Chat scope
        if (config.chatScope.public_chat_only.includes(`!${command}`)) {
             // Command is allowed in public chat specifically
        } else if (config.chatScope.dm_public_chat.includes(`!${command}`)) {
             // Command is allowed in both DM and public chat
        } else {
             // Command is restricted to DM only
             await bot.message.send(`Sorry, the command '${config.botPrefix}${command}' can only be used in DM.`);
             logEvent('warning', `Command '${config.botPrefix}${command}' attempted in public chat, but it's DM only.`);
             return;
        }

        // --- Command Authorization & Execution ---
        let requiredRole = 'basic';
        if (config.commandPermissions.mod.includes(`!${command}`)) requiredRole = 'mod';
        if (config.commandPermissions.owner.includes(`!${command}`)) requiredRole = 'owner';

        if (!hasPermission(user.id, requiredRole)) {
            await bot.message.send(`@${user.username} You do not have permission to use this command.`);
            return;
        }

        let commandHandled = true;
        switch (command) {
            case 'help':
                await handleHelpCommand(user, 'public');
                break;
            case 'mod':
                await handleModCommand(user, 'public');
                break;
            case 'stop':
                await handleStopEmoteCommand(user);
                break;
            case 'f1':
            case 'f2':
            case 'f3':
                await handleFCommand(user, command);
                break;
            case 'myid':
                await bot.message.send(`@${user.username} Your User ID is: ${user.id}`);
                break;
            case 'goto':
                if (targetUserId) {
                    await handleGotoCommand(user, targetUsernameArg);
                } else {
                    await bot.message.send(`@${user.username} Usage: !goto @username`);
                }
                break;
            case 'walk':
                await handleWalkCommand(user);
                break;
            case 'setbot':
                await handleSetBotCommand(user);
                break;
            case 't1':
                if (targetUserId) {
                    await handleT1Command(user, targetUsernameArg);
                } else {
                    await bot.message.send(`@${user.username} Usage: !t1 @username`);
                }
                break;
            case 'all':
                const emoteToPerform = args[0];
                if (emoteToPerform && config.emoteDefinitions[emoteToPerform.toLowerCase()]) {
                    await handleAllEmoteCommand(user, emoteToPerform.toLowerCase());
                } else {
                    await bot.message.send(`@${user.username} Usage: !all <emotename>`);
                }
                break;
            case 'summon':
                if (targetUserId) {
                    await handleSummonCommand(user, targetUsernameArg);
                } else {
                    await bot.message.send(`@${user.username} Usage: !summon @username`);
                }
                break;

            case 'idban': case 'idunban': case 'idmute': case 'idunmute':
            case 'role': case 'unrole':
                if (targetUserId) {
                    const targetUserObj = { id: targetUserId, username: targetUsernameArg };
                    if (command === 'idban') await handleIdBanCommand(user, targetUserObj);
                    else if (command === 'idunban') await handleIdUnbanCommand(user, targetUserObj);
                    else if (command === 'idmute') await handleIdMuteCommand(user, targetUserObj);
                    else if (command === 'idunmute') await handleIdUnmuteCommand(user, targetUserObj);
                    else if (command === 'role') await handleRoleCommand(user, targetUserObj);
                    else if (command === 'unrole') await handleUnroleCommand(user, targetUserObj);
                } else {
                    await bot.message.send(`@${user.username} Usage: !${command} @username`);
                }
                break;
            case 'freeze':
                if (targetUserId) { await handleFreezeCommand(user, targetUserId); } else { await bot.message.send(`@${user.username} Usage: !freeze @username`); } break;
            case 'unfreeze':
                if (targetUserId) { await handleUnfreezeCommand(user, targetUserId); } else { await bot.message.send(`@${user.username} Usage: !unfreeze @username`); } break;
            case 'k':
                if (targetUserId) { await handleKickCommand(user, targetUserId); } else { await bot.message.send(`@${user.username} Usage: !k @username`); } break;
            case 'b':
                if (targetUserId) { await handleBanCommand(user, targetUserId); } else { await bot.message.send(`@${user.username} Usage: !b @username`); } break;
            case 'm':
                if (targetUserId) { await handleMuteCommand(user, targetUserId); } else { await bot.message.send(`@${user.username} Usage: !m @username`); } break;
            case 'vip':
                await handleVipCommand(user);
                break;
            case 'invite':
                await handleInviteAllCommand(user);
                break;
            case 'boost':
                const amountBoost = parseInt(args[0]);
                if (!isNaN(amountBoost) && amountBoost > 0) {
                    await handleBoostCommand(user, amountBoost);
                } else {
                    await bot.message.send(`@${user.username} Usage: !boost <amount>`);
                }
                break;
            case 'voice':
                const amountVoice = parseInt(args[0]);
                if (!isNaN(amountVoice) && amountVoice > 0) {
                    await handleVoiceCommand(user, amountVoice);
                } else {
                    await bot.message.send(`@${user.username} Usage: !voice <amount>`);
                }
                break;
            case 'equip':
                const itemToEquip = args.join(' ');
                if (itemToEquip) {
                    await handleEquipCommand(user, itemToEquip);
                } else {
                    await bot.message.send(`@${user.username} Usage: !equip <item_id>`);
                }
                break;
            case 'remove':
                const categoryToRemove = args.join(' ');
                if (categoryToRemove) {
                    await handleRemoveCommand(user, categoryToRemove);
                } else {
                    await bot.message.send(`@${user.username} Usage: !remove <category>`);
                }
                break;
            case 'color':
                const colorCategory = args[0];
                const colorIndex = parseInt(args[1]);
                if (colorCategory && !isNaN(colorIndex)) {
                    await handleColorCommand(user, colorCategory, colorIndex);
                } else {
                    await bot.message.send(`@${user.username} Usage: !color <category> <index>`);
                }
                break;
            case 'copy':
                if (targetUserId) {
                    await handleCopyOutfitCommand(user, targetUserId);
                } else {
                    await bot.message.send(`@${user.username} Usage: !copy @username`);
                }
                break;
            case 'longsay':
                const longText = args.join(' ');
                // Specific check for missing argument
                if (!longText) {
                     await bot.message.send(`@${user.username} Usage: !longsay <text>. Please provide the text to send.`);
                     return;
                }
                if (config.features.enableLongMessageSend) {
                    await handleLongSayCommand(user, longText, 'public');
                } else {
                    // More precise message about feature being disabled
                    await bot.message.send(`@${user.username} The !longsay feature is currently disabled.`);
                }
                break;
            case 'sendfilecontent':
                const fileName = args[0];
                if (!fileName) { // Specific check for missing argument
                     await bot.message.send(`@${user.username} Usage: !sendfilecontent <filename>. Please provide the filename.`);
                     return;
                }
                if (config.features.enableFileContentSend) {
                    await handleSendFileContentCommand(user, fileName, 'public');
                } else {
                    // More precise message about feature being disabled
                    await bot.message.send(`@${user.username} The !sendfilecontent feature is currently disabled.`);
                }
                break;
            default:
                commandHandled = false;
        }
        if (!commandHandled) {
            logEvent('warning', `Unknown command received in public chat from ${user.username}: ${message}`);
        }
    });

    bot.on('messageCreate', async (userId, conversationData, messageContent) => {
        logEvent('dmMessage', `[DIRECT MESSAGE] From User ID: ${userId}, Conv ID: ${conversationData.id}, Content: ${messageContent}`);

        if (userId === bot.info.user.id) return; // Ignore DMs from bot itself

        if (isMuted(userId)) {
            logEvent('debug', `DM from ${userId} ignored due to mute.`);
            return;
        }
        if (isBanned(userId)) {
            logEvent('debug', `DM from ${userId} ignored due to ban.`);
            return;
        }

        const message = messageContent || ''; // Ensure messageContent is not undefined
        // Try to get username from cache/room players, fallback if not found
        let username = await bot.room.players.username(userId);
        const user = { id: userId, username: username || `User_${userId.substring(0, 5)}` }; 

        // AI/Chatbot reply for DM (if not starting with prefix)
        if (!message.startsWith(config.botPrefix) && config.features.aiReplyInWhispers) {
            logEvent('botAction', `AI processing DM from ${user.username}.`);
            try {
                const aiResponse = await getAiResponse(message); // Implement getAiResponse separately
                await bot.direct.send(conversationData.id, aiResponse);
            } catch (error) {
                logEvent('error', `AI response error for DM: ${error.message}`);
                await bot.direct.send(conversationData.id, "I'm sorry, I couldn't process your request right now.");
            }
            return;
        }

        if (!message.startsWith(config.botPrefix)) {
            logEvent('debug', `DM from ${user.username} did not start with prefix and AI is not enabled or not an AI message.`);
            return;
        }

        // Process commands with prefix in DM
        const args = message.slice(config.botPrefix.length).trim().split(/ +/);
        const command = args.shift().toLowerCase();
        const targetUsernameArg = args[0] && args[0].startsWith('@') ? args[0].substring(1) : null;
        let targetUserId = null;
        if (targetUsernameArg) {
            try {
                targetUserId = await bot.room.players.id(targetUsernameArg);
                 if (!targetUserId) {
                    await bot.direct.send(conversationData.id, `User '${targetUsernameArg}' not found in the room.`);
                    logEvent('warning', `Target user '${targetUsernameArg}' not found for command ${command}.`);
                    return;
                }
            } catch (e) {
                await bot.direct.send(conversationData.id, `Error finding target user '${targetUsernameArg}'.`);
                logEvent('error', `Error finding target user '${targetUsernameArg}': ${e.message}`);
                return;
            }
        }

        logEvent('commandLog', `Processing DM command from ${user.username} (${user.id}): ${message}`);

        // Check if command is allowed in DM scope
        if (config.chatScope.dm_only.includes(`!${command}`)) {
             // Command is allowed in DM specifically
        } else if (config.chatScope.dm_public_chat.includes(`!${command}`)) {
             // Command is allowed in both DM and public chat
        } else {
             // Command is restricted to Public Chat only
             await bot.direct.send(conversationData.id, `Sorry, the command '${config.botPrefix}${command}' works only in public chat.`);
             logEvent('warning', `Command '${config.botPrefix}${command}' attempted in DM, but it's public chat only.`);
             return;
        }

        let requiredRole = 'basic';
        if (config.commandPermissions.mod.includes(`!${command}`)) requiredRole = 'mod';
        if (config.commandPermissions.owner.includes(`!${command}`)) requiredRole = 'owner';

        if (!hasPermission(user.id, requiredRole)) {
            await bot.direct.send(conversationData.id, `You do not have permission to use this command.`);
            return;
        }

        let commandHandled = true;
        switch (command) {
            case 'help':
                await handleHelpCommand(user, 'dm', conversationData.id);
                break;
            case 'mod':
                await handleModCommand(user, 'dm', conversationData.id);
                break;
            case 'emotelist':
                await handleEmoteListCommand(user, conversationData.id);
                break;
            case 'addowner':
                if (targetUserId) {
                    await handleAddOwnerCommand(user, { id: targetUserId, username: targetUsernameArg }, conversationData.id);
                } else {
                    await bot.direct.send(conversationData.id, `Usage: !addowner @username`);
                }
                break;
            case 'removeowner':
                if (targetUserId) {
                    await handleRemoveOwnerCommand(user, { id: targetUserId, username: targetUsernameArg }, conversationData.id);
                } else {
                    await bot.direct.send(conversationData.id, `Usage: !removeowner @username`);
                }
                break;
            case 'list':
                await handleListRolesCommand(user, conversationData.id);
                break;
            case 'bad':
                const badWord = args[0];
                if (badWord) {
                    if (addBadWord(badWord)) {
                        await bot.direct.send(conversationData.id, `'${badWord}' added to forbidden words.`);
                    } else {
                        await bot.direct.send(conversationData.id, `'${badWord}' is already in the list.`);
                    }
                } else {
                    await bot.direct.send(conversationData.id, `Usage: !bad <word>`);
                }
                break;
            case 'rbad':
                const rBadWord = args[0];
                if (rBadWord) {
                    if (removeBadWord(rBadWord)) {
                        await bot.direct.send(conversationData.id, `'${rBadWord}' removed from forbidden words.`);
                    } else {
                        await bot.direct.send(conversationData.id, `'${rBadWord}' not found in the list.`);
                    }
                } else {
                    await bot.direct.send(conversationData.id, `Usage: !rbad <word>`);
                }
                break;
            case 'listbadword':
                const badWordsList = badWords.words.length > 0 ? badWords.words.join(', ') : 'None';
                await bot.direct.send(conversationData.id, `Forbidden Words: ${badWordsList}`);
                break;
            default:
                commandHandled = false;
        }
        if (!commandHandled) {
            await bot.direct.send(conversationData.id, `Unknown command: '${config.botPrefix}${command}'. Use !help for commands.`);
            logEvent('warning', `Unknown command received in DM from ${user.username}: ${message}`);
        }
    });

    bot.on('whisperCreate', async (user, message) => {
        logEvent('whisperMessage', `[WHISPER] ${user.username} (${user.id}): ${message}`);

        if (user.id === bot.info.user.id) return; // Ignore bot's own whispers

        if (isMuted(user.id)) {
            logEvent('debug', `Whisper from ${user.username} ignored due to mute.`);
            return;
        }
        if (isBanned(user.id)) {
            logEvent('debug', `Whisper from ${user.username} ignored due to ban.`);
            return;
        }

        // Error for prefix in whisper
        if (message.startsWith(config.botPrefix)) {
            await reply(user, `"${config.botPrefix}" works only in DM/public chat. For AI interaction, just type naturally.`, 'whisper');
            logEvent('warning', `User ${user.username} attempted command with prefix in whisper.`);
            return;
        }

        // AI Integration for Whisper (if enabled)
        if (config.features.aiReplyInWhispers) {
            logEvent('botAction', `AI processing Whisper from ${user.username}.`);
            try {
                const aiResponse = await getAiResponse(message);
                await reply(user, aiResponse, 'whisper');
            } catch (error) {
                logEvent('error', `AI response error for Whisper: ${error.message}`);
                await reply(user, "I'm sorry, I couldn't process your request right now.", 'whisper');
            }
        } else {
            logEvent('debug', `Whisper from ${user.username} ignored as AI for whispers is disabled.`);
        }
    });

    bot.on('playerMove', async (user, newPosition) => {
        logEvent('debug', `Player ${user.username} (${user.id}) moved to X:${newPosition.x}, Y:${newPosition.y}, Z:${newPosition.z}`);

        // Player Movement Teleport Correction & Freeze
        if (config.features.playerMovementTeleportCorrection.enabled && user.id !== bot.info.user.id) { // Not bot itself
            if (frozenUsers.locked[user.id]) { // If user is frozen
                const lockedPos = frozenUsers.locked[user.id];
                // Check if newPosition is significantly different from lockedPos
                // Use a small tolerance for floating point comparisons
                const tolerance = 0.01; 
                const movedFromLocked = Math.abs(newPosition.x - lockedPos.x) > tolerance ||
                                        Math.abs(newPosition.y - lockedPos.y) > tolerance ||
                                        Math.abs(newPosition.z - lockedPos.z) > tolerance;

                if (movedFromLocked) {
                    logEvent('warning', `Frozen user ${user.username} moved from locked position. Teleporting back.`);
                    try {
                        await bot.player.teleport(user.id, lockedPos.x, lockedPos.y, lockedPos.z, lockedPos.facing);
                    } catch (err) {
                        logEvent('error', `Failed to teleport frozen user ${user.username} back: ${err.message}`);
                    }
                }
            } else { // Auto-teleport for significant Y-axis change (only for non-frozen users)
                const lastKnownPos = bot.room.cache.position(user.id);
                if (lastKnownPos) {
                    const deltaY = Math.abs(newPosition.y - lastKnownPos.y);
                    const distance = Math.sqrt(
                        Math.pow(newPosition.x - lastKnownPos.x, 2) +
                        Math.pow(newPosition.y - lastKnownPos.y, 2) +
                        Math.pow(newPosition.z - lastKnownPos.z, 2)
                    );

                    if (deltaY > config.features.playerMovementTeleportCorrection.y_threshold || distance > config.features.playerMovementTeleportCorrection.max_distance_teleport) {
                        logEvent('debug', `Significant movement detected for ${user.username}. Y-delta: ${deltaY.toFixed(2)}, Distance: ${distance.toFixed(2)}. Teleporting to confirm position.`);
                        try {
                            await bot.player.teleport(user.id, newPosition.x, newPosition.y, newPosition.z, newPosition.facing);
                        } catch (err) {
                            logEvent('error', `Failed to teleport ${user.username} during movement correction: ${err.message}`);
                        }
                    }
                }
            }
        }
    });

    bot.on('playerEmote', (sender, receiver, emoteId) => {
        logEvent('emote', `Sender: ${sender.username}, Receiver: ${receiver.username}, Emote ID: ${emoteId}`);
    });

    bot.on('playerReact', (sender, receiver, reaction) => {
        logEvent('debug', `Player ${sender.username} reacted '${reaction}' to ${receiver.username}.`);
    });

    bot.on('playerTip', (sender, receiver, item) => {
        logEvent('debug', `Player ${sender.username} tipped ${receiver.username} ${item.amount} ${item.type}.`);
    });

    bot.on('voiceCreate', (users, secondsLeft) => {
        logEvent('debug', `Voice chat update. Seconds left: ${secondsLeft}. Users: ${users.map(u => `${u.user.username} (${u.status})`).join(', ')}`);
    });

    bot.on('roomModerate', (moderatorId, targetUserId, moderationType, duration) => {
        logEvent('info', `Room moderation by ${moderatorId}: User ${targetUserId} was ${moderationType} for ${duration || 'N/A'} seconds.`);
    });

    bot.on('error', (err) => {
        logEvent('error', `Bot Error: ${err}`);
    });

    // --- Start Bot ---
    bot.login(config.botAuth.token, config.botAuth.roomId);
}

// --- Command Handling Functions ---

// Generic reply function for commands (public, dm, whisper)
async function reply(user, message, type, conversationId = null) {
    let finalMessage = message;
    let maxLength = -1; // No limit by default

    // Determine max length based on message type
    if (type === 'whisper' && config.messageLimits.whisper !== undefined) {
        maxLength = config.messageLimits.whisper;
    } else if (type === 'dm' && config.messageLimits.dm !== undefined) {
        maxLength = config.messageLimits.dm;
    } 
    // Public chat messages are handled by handleLongSayCommand for splitting,
    // so we don't apply hard cropping here.

    if (maxLength !== -1 && message.length > maxLength) {
        finalMessage = message.substring(0, maxLength - 3) + '...';
        logEvent('debug', `Message cropped for ${type} to ${maxLength} chars: "${finalMessage}"`);
    }

    try {
        if (type === 'public') {
            await bot.message.send(finalMessage);
        } else if (type === 'dm' && conversationId) {
            await bot.direct.send(conversationId, finalMessage);
        } else if (type === 'whisper') {
            await bot.whisper.send(user.id, finalMessage);
        }
        logEvent('botAction', `Sent ${type} reply to ${user.username}: ${finalMessage}`);
    } catch (error) {
        logEvent('error', `Failed to send ${type} message to ${user.username}: ${error.message}`);
    }
}

async function handleHelpCommand(user, chatType, conversationId = null) {
    const { header, commands, footer } = messages.helpCommandResponse;
    
    // Format the commands from the JSON object
    const commandList = Object.entries(commands)
        .map(([command, description]) => `${command} : ${description}`)
        .join('\n');

    const helpMessage = `${header.replace('{}', user.username)}\n${commandList}\n\n${footer}`;
    
    await reply(user, helpMessage, chatType, conversationId);
}

async function handleModCommand(user, chatType, conversationId = null) {
    // If command is !mod, and user is not mod/owner, send no permission message
    // This check is already done by hasPermission before calling this handler
    const { header, modCommands, ownerHeader, ownerCommands } = messages.modCommandResponse;
    let messageToSend = `${header.replace('{}', user.username)}\n`;
    
    // Format mod commands
    const modCommandList = Object.entries(modCommands)
        .map(([command, description]) => `${command} : ${description}`)
        .join('\n');
    
    messageToSend += modCommandList;

    // If the user is an owner, add owner commands as well
    if (hasPermission(user.id, 'owner')) {
         // Append owner commands if user is owner
         const ownerCommandList = Object.entries(ownerCommands)
            .map(([command, description]) => `${command} : ${description}`)
            .join('\n');
         // If messageToSend is still default (only header + mod commands), append owner commands
         if (messageToSend === `${header.replace('{}', user.username)}\n${modCommandList}\n`) {
             messageToSend += `${ownerHeader}\n${ownerCommandList}`;
         } else { // This path implies the message only had the header portion before (no mod commands were added), likely due to `hasPermission` check.
             messageToSend += `${ownerHeader}\n${ownerCommandList}`;
         }
    }
    
    await reply(user, messageToSend, chatType, conversationId);
}

async function handleEmoteLoopCommand(user, emoteName) {
    logEvent('commandLog', `User ${user.username} requested emote loop: ${emoteName}`);
    if (emoteLoops.has(user.id)) {
        clearTimeout(emoteLoops.get(user.id).timeoutId);
        emoteLoops.delete(user.id);
        await bot.message.send(`@${user.username} Stopped previous emote loop.`);
    }

    const emoteDef = config.emoteDefinitions[emoteName];
    if (!emoteDef || !emoteDef.id) { // Ensure emoteDef and emoteDef.id exist
        await bot.message.send(`@${user.username} Sorry, I don't know the emote '${emoteName}'.`);
        return;
    }

    const performEmote = async () => {
        // Check if user is still in the room before performing emote
        const playersInRoom = await bot.room.players.get();
        const userStillPresent = playersInRoom.some(([player]) => player.id === user.id);
        if (!userStillPresent) {
            logEvent('debug', `User ${user.username} left, stopping emote loop.`);
            if (emoteLoops.has(user.id)) {
                clearTimeout(emoteLoops.get(user.id).timeoutId);
                emoteLoops.delete(user.id);
            }
            return;
        }

        try {
            await bot.player.emote(user.id, emoteDef.id);
            logEvent('debug', `Performed ${emoteName} for ${user.username}.`);
        } catch (error) {
            logEvent('error', `Error performing emote ${emoteName} for ${user.username}: ${error.message}`);
            // If user leaves or error, stop the loop for this user.
            if (emoteLoops.has(user.id)) {
                clearTimeout(emoteLoops.get(user.id).timeoutId);
                emoteLoops.delete(user.id);
                await bot.message.send(`@${user.username} Stopped emote loop due to an error or user-leave.`);
            }
            return;
        }

        const timeoutId = setTimeout(performEmote, emoteDef.duration || 3000); // Default to 3s if no duration
        emoteLoops.set(user.id, { timeoutId, emoteId: emoteDef.id, duration: emoteDef.duration });
    };

    performEmote(); // Initial call
    await bot.message.send(`@${user.username} Performing '${emoteName}' in a loop. Type '!stop' to halt.`);
}

async function handleStopEmoteCommand(user) {
    logEvent('commandLog', `User ${user.username} requested to stop emote.`);
    if (emoteLoops.has(user.id)) {
        clearTimeout(emoteLoops.get(user.id).timeoutId);
        emoteLoops.delete(user.id);
        await bot.message.send(`@${user.username} Your emote loop has been stopped.`);
    } else {
        await bot.message.send(`@${user.username} You don't have an active emote loop.`);
    }
}

async function handleFCommand(user, command) {
    const preset = config.teleportPresets[command];
    if (preset) {
        try {
            await bot.player.teleport(user.id, preset.x, preset.y, preset.z, preset.facing);
            await bot.message.send(`@${user.username} Teleported to ${command.toUpperCase()} location.`);
            logEvent('botAction', `Teleported ${user.username} to ${command.toUpperCase()}.`);
        } catch (error) {
            await bot.message.send(`@${user.username} Failed to teleport: ${error.message}`);
            logEvent('error', `Failed to teleport ${user.username} to ${command.toUpperCase()}: ${error.message}`);
        }
    } else {
        await bot.message.send(`@${user.username} Unknown destination for ${command}.`);
    }
}

async function handleSingleEmoteCommand(targetUserId, emoteName) {
    const emoteDef = config.emoteDefinitions[emoteName];
    if (emoteDef && emoteDef.id) { // Ensure emoteDef and emoteDef.id exist
        try {
            await bot.player.emote(targetUserId, emoteDef.id);
            logEvent('botAction', `Made user ${targetUserId} perform ${emoteName}.`);
        } catch (error) {
            logEvent('error', `Failed to make user ${targetUserId} perform ${emoteName}: ${error.message}`);
        }
    }
}

async function handleWalkCommand(user) {
    logEvent('commandLog', `User ${user.username} requested bot to walk.`);
    try {
        const userPosition = await bot.room.players.position(user.id);
        if (userPosition) {
            // Corrected: Make the bot walk to the user's current coordinates
            await bot.move.walk(userPosition.x, userPosition.y, userPosition.z, userPosition.facing);
            await bot.message.send(`@${user.username} Bot is walking to your location.`);
            logEvent('botAction', `Bot walking to ${user.username}'s location.`);
        } else {
            await bot.message.send(`@${user.username} Could not find your current position.`);
        }
    } catch (error) {
        await bot.message.send(`@${user.username} Failed to make bot walk: ${error.message}`);
        logEvent('error', `Failed to make bot walk for ${user.username}: ${error.message}`);
    }
}

async function handleSetBotCommand(user) {
    logEvent('commandLog', `User ${user.username} requested to set bot's permanent location.`);
    try {
        const userPosition = await bot.room.players.position(user.id);
        if (userPosition) {
            await bot.player.teleport(bot.info.user.id, userPosition.x, userPosition.y, userPosition.z, userPosition.facing);
            botLastSetLocation = userPosition;
            await saveJson(config.permissionFiles.botLocation, botLastSetLocation);
            await bot.message.send(`@${user.username} Bot's permanent location saved and bot moved there.`);
            logEvent('botAction', `Bot permanent location set to ${userPosition.x},${userPosition.y},${userPosition.z} by ${user.username}.`);
        } else {
            await bot.message.send(`@${user.username} Could not find your current position to set bot location.`);
        }
    } catch (error) {
        await bot.message.send(`@${user.username} Failed to set bot location: ${error.message}`);
        logEvent('error', `Failed to set bot location for ${user.username}: ${error.message}`);
    }
}

async function handleT1Command(commandSender, targetUsername) {
    logEvent('commandLog', `User ${commandSender.username} requested to teleport ${targetUsername} to t1.`);
    const targetUserId = await bot.room.players.id(targetUsername);
    if (!targetUserId) {
        await bot.message.send(`@${commandSender.username} User '${targetUsername}' not found.`);
        return;
    }
    const preset = config.teleportPresets.t1;
    if (preset) {
        try {
            await bot.player.teleport(targetUserId, preset.x, preset.y, preset.z, preset.facing);
            await bot.message.send(`@${commandSender.username} Teleported ${targetUsername} to T1 location.`);
            logEvent('botAction', `Teleported ${targetUsername} to T1 by ${commandSender.username}.`);
        } catch (error) {
            await bot.message.send(`@${commandSender.username} Failed to teleport ${targetUsername}: ${error.message}`);
            logEvent('error', `Failed to teleport ${targetUsername} to T1: ${error.message}`);
        }
    }
}

async function handleVipCommand(user) {
    logEvent('commandLog', `User ${user.username} requested VIP teleport.`);
    const preset = config.teleportPresets.vip;
    if (preset) {
        try {
            await bot.player.teleport(user.id, preset.x, preset.y, preset.z, preset.facing);
            await bot.message.send(`@${user.username} Teleported to VIP location.`);
            logEvent('botAction', `Teleported ${user.username} to VIP area.`);
        } catch (error) {
            await bot.message.send(`@${user.username} Failed to teleport to VIP: ${error.message}`);
            logEvent('error', `Failed to teleport ${user.username} to VIP: ${error.message}`);
        }
    }
}

async function handleAllEmoteCommand(commandSender, emoteName) {
    logEvent('commandLog', `User ${commandSender.username} requested all users perform emote: ${emoteName}.`);
    const emoteDef = config.emoteDefinitions[emoteName];
    if (!emoteDef || !emoteDef.id) { // Ensure emoteDef and emoteDef.id exist
        await bot.message.send(`@${commandSender.username} Unknown emote '${emoteName}'.`);
        return;
    }

    try {
        const players = await bot.room.players.get();
        let count = 0;
        for (const [user, position] of players) {
            if (user.id === bot.info.user.id) continue; // Don't make bot emote itself here
            try {
                await bot.player.emote(user.id, emoteDef.id);
                count++;
                await new Promise(resolve => setTimeout(resolve, 500)); // Small delay to avoid rate limits
            } catch (e) {
                logEvent('error', `Failed to make ${user.username} emote: ${e.message}`);
            }
        }
        await bot.message.send(`@${commandSender.username} Made ${count} users perform '${emoteName}'.`);
        logEvent('botAction', `Made ${count} users perform '${emoteName}' by ${commandSender.username}.`);
    } catch (error) {
        await bot.message.send(`@${commandSender.username} Failed to make all users emote: ${error.message}`);
        logEvent('error', `Failed to make all users emote: ${error.message}`);
    }
}

async function handleIdBanCommand(commandSender, targetUser, conversationId = null, chatType = 'public') {
    if (!hasPermission(commandSender.id, 'mod')) { // Double check permission
        await reply(commandSender, `You do not have permission to use this command.`, chatType, conversationId);
        return;
    }
    if (getRole(targetUser.id) === 'owner' || getRole(targetUser.id) === 'mod') {
        await reply(commandSender, `Cannot ban owner/mod.`, chatType, conversationId);
        return;
    }
    if (isBanned(targetUser.id)) {
        await reply(commandSender, `@${targetUser.username} is already banned.`, chatType, conversationId);
    } else {
        bannedUsers.users[targetUser.id] = { blocked_commands: true, timestamp: null, duration_minutes: null }; // Permanent ban
        await saveJson(config.permissionFiles.bannedCommands, bannedUsers);
        await reply(commandSender, `@${targetUser.username} has been banned from using commands.`, chatType, conversationId);
        logEvent('botAction', `${targetUser.username} banned from commands by ${commandSender.username}.`);
    }
}

async function handleIdUnbanCommand(commandSender, targetUser, conversationId = null, chatType = 'public') {
    if (!hasPermission(commandSender.id, 'mod')) {
        await reply(commandSender, `You do not have permission to use this command.`, chatType, conversationId);
        return;
    }
    if (!isBanned(targetUser.id)) {
        await reply(commandSender, `@${targetUser.username} is not banned.`, chatType, conversationId);
    } else {
        delete bannedUsers.users[targetUser.id];
        await saveJson(config.permissionFiles.bannedCommands, bannedUsers);
        await reply(commandSender, `@${targetUser.username} has been unbanned from using commands.`, chatType, conversationId);
        logEvent('botAction', `${targetUser.username} unbanned from commands by ${commandSender.username}.`);
    }
}

async function handleIdMuteCommand(commandSender, targetUser, conversationId = null, chatType = 'public') {
    if (!hasPermission(commandSender.id, 'mod')) {
        await reply(commandSender, `You do not have permission to use this command.`, chatType, conversationId);
        return;
    }
    if (getRole(targetUser.id) === 'owner' || getRole(targetUser.id) === 'mod') {
        await reply(commandSender, `Cannot mute owner/mod.`, chatType, conversationId);
        return;
    }
    if (isMuted(targetUser.id)) {
        await reply(commandSender, `@${targetUser.username} is already muted.`, chatType, conversationId);
    } else {
        mutedUsers.users[targetUser.id] = { muted_chat: true, duration_minutes: 15, timestamp: new Date().toISOString() };
        await saveJson(config.permissionFiles.mutedMessages, mutedUsers);
        await reply(commandSender, `@${targetUser.username} has been muted for 15 minutes.`, chatType, conversationId);
        logEvent('botAction', `${targetUser.username} muted for 15 mins by ${commandSender.username}.`);
    }
}

async function handleIdUnmuteCommand(commandSender, targetUser, conversationId = null, chatType = 'public') {
    if (!hasPermission(commandSender.id, 'mod')) {
        await reply(commandSender, `You do not have permission to use this command.`, chatType, conversationId);
        return;
    }
    if (!isMuted(targetUser.id)) {
        await reply(commandSender, `@${targetUser.username} is not muted.`, chatType, conversationId);
    } else {
        delete mutedUsers.users[targetUser.id];
        await saveJson(config.permissionFiles.mutedMessages, mutedUsers);
        await reply(commandSender, `@${targetUser.username} has been unmuted.`, chatType, conversationId);
        logEvent('botAction', `${targetUser.username} unmuted by ${commandSender.username}.`);
    }
}

async function handleRoleCommand(commandSender, targetUser, conversationId = null, chatType = 'public') {
    if (!hasPermission(commandSender.id, 'owner')) {
        await reply(commandSender, `You do not have permission to use this command.`, chatType, conversationId);
        return;
    }
    if (getRole(targetUser.id) === 'owner') {
        await reply(commandSender, `Cannot change owner's role.`, chatType, conversationId);
        return;
    }
    if (permissions.mods.includes(targetUser.id)) {
        await reply(commandSender, `@${targetUser.username} is already a mod.`, chatType, conversationId);
    } else {
        permissions.mods.push(targetUser.id);
        await saveJson(config.permissionFiles.roles, permissions);
        await reply(commandSender, `@${targetUser.username} has been assigned the 'mod' role.`, chatType, conversationId);
        logEvent('botAction', `${targetUser.username} assigned 'mod' role by ${commandSender.username}.`);
    }
}

async function handleUnroleCommand(commandSender, targetUser, conversationId = null, chatType = 'public') {
    if (!hasPermission(commandSender.id, 'owner')) {
        await reply(commandSender, `You do not have permission to use this command.`, chatType, conversationId);
        return;
    }
    if (getRole(targetUser.id) === 'owner') {
        await reply(commandSender, `Cannot change owner's role.`, chatType, conversationId);
        return;
    }
    const index = permissions.mods.indexOf(targetUser.id);
    if (index > -1) {
        permissions.mods.splice(index, 1);
        await saveJson(config.permissionFiles.roles, permissions);
        await reply(commandSender, `@${targetUser.username} has been removed from the 'mod' role.`, chatType, conversationId);
        logEvent('botAction', `${targetUser.username} removed from 'mod' role by ${commandSender.username}.`);
    } else {
        await reply(commandSender, `@${targetUser.username} is not a mod.`, chatType, conversationId);
    }
}

async function handleAddOwnerCommand(commandSender, targetUser, conversationId = null) {
    if (!hasPermission(commandSender.id, 'owner')) {
        await reply(commandSender, `You must be an owner to use this command.`, 'dm', conversationId);
        return;
    }
    if (permissions.owners.includes(targetUser.id)) {
        await reply(commandSender, `@${targetUser.username} is already an owner.`, 'dm', conversationId);
    } else {
        permissions.owners.push(targetUser.id);
        // Optionally remove from mods if they were one
        const modIndex = permissions.mods.indexOf(targetUser.id);
        if (modIndex > -1) {
            permissions.mods.splice(modIndex, 1);
        }
        await saveJson(config.permissionFiles.roles, permissions);
        await reply(commandSender, `@${targetUser.username} has been assigned the 'owner' role.`, 'dm', conversationId);
        logEvent('botAction', `${targetUser.username} assigned 'owner' role by ${commandSender.username}.`);
    }
}

async function handleRemoveOwnerCommand(commandSender, targetUser, conversationId = null) {
    if (!hasPermission(commandSender.id, 'owner') || commandSender.id === targetUser.id) { // Cannot remove self
        await reply(commandSender, `You must be an owner to use this command, and cannot remove yourself.`, 'dm', conversationId);
        return;
    }
    const index = permissions.owners.indexOf(targetUser.id);
    if (index > -1) {
        permissions.owners.splice(index, 1);
        await saveJson(config.permissionFiles.roles, permissions);
        await reply(commandSender, `@${targetUser.username} has been removed from the 'owner' role.`, 'dm', conversationId);
        logEvent('botAction', `${targetUser.username} removed from 'owner' role by ${commandSender.username}.`);
    } else {
        await reply(commandSender, `@${targetUser.username} is not an owner.`, 'dm', conversationId);
    }
}

async function handleListRolesCommand(user, conversationId = null) {
    const ownerNameList = await Promise.all(permissions.owners.map(async id => await bot.room.players.username(id) || id));
    const modNameList = await Promise.all(permissions.mods.map(async id => await bot.room.players.username(id) || id));

    const ownerList = ownerNameList.length > 0 ? ownerNameList.join(', ') : 'None';
    const modList = modNameList.length > 0 ? modNameList.join(', ') : 'None';
    
    const message = `✨ Current Roles:\nOwners: ${ownerList}\nMods: ${modList}`;
    await reply(user, message, 'dm', conversationId);
}

async function handleSummonCommand(commandSender, targetUsername) {
    logEvent('commandLog', `User ${commandSender.username} requested to summon ${targetUsername}.`);
    const targetUserId = await bot.room.players.id(targetUsername);
    if (!targetUserId) {
        await bot.message.send(`@${commandSender.username} User '${targetUsername}' not found.`);
        return;
    }
    if (getRole(targetUserId) === 'owner' || getRole(targetUserId) === 'mod') {
         await bot.message.send(`@${commandSender.username} Cannot summon owner/mod.`);
         logEvent('warning', `Attempt to summon owner/mod by ${commandSender.username}.`);
         return;
    }
    try {
        const senderPosition = await bot.room.players.position(commandSender.id);
        if (senderPosition) {
            await bot.player.teleport(targetUserId, senderPosition.x, senderPosition.y, senderPosition.z, senderPosition.facing);
            await bot.message.send(`@${commandSender.username} Summoned ${targetUsername} to your location.`);
            logEvent('botAction', `Summoned ${targetUsername} to ${commandSender.username}'s location.`);
        } else {
            await bot.message.send(`@${commandSender.username} Could not find your current position.`);
        }
    } catch (error) {
        await bot.message.send(`@${commandSender.username} Failed to summon ${targetUsername}: ${error.message}`);
        logEvent('error', `Failed to summon ${targetUsername} by ${commandSender.username}: ${error.message}`);
    }
}

async function handleGotoCommand(commandSender, targetUsername) {
    logEvent('commandLog', `User ${commandSender.username} requested to go to ${targetUsername}.`);
    const targetUserId = await bot.room.players.id(targetUsername);
    if (!targetUserId) {
        await bot.message.send(`@${commandSender.username} User '${targetUsername}' not found.`);
        return;
    }
    try {
        const targetPosition = await bot.room.players.position(targetUserId);
        if (targetPosition) {
            await bot.player.teleport(commandSender.id, targetPosition.x, targetPosition.y, targetPosition.z, targetPosition.facing);
            await bot.message.send(`@${commandSender.username} Teleported to ${targetUsername}'s location.`);
            logEvent('botAction', `Teleported ${commandSender.username} to ${targetUsername}'s location.`);
        } else {
            await bot.message.send(`@${commandSender.username} Could not find ${targetUsername}'s position.`);
        }
    } catch (error) {
        await bot.message.send(`@${commandSender.username} Failed to go to ${targetUsername}: ${error.message}`);
        logEvent('error', `Failed to teleport ${commandSender.username} to ${targetUsername}: ${error.message}`);
    }
}

async function handleFreezeCommand(commandSender, targetUserId) {
    logEvent('commandLog', `User ${commandSender.username} requested to freeze ${targetUserId}.`);
    const targetUser = {id: targetUserId, username: await bot.room.players.username(targetUserId)};
    if(getRole(targetUserId) === 'owner' || getRole(targetUserId) === 'mod' || targetUserId === bot.info.user.id) {
         await bot.message.send(`@${commandSender.username} Cannot freeze owner/mod/bot.`);
         logEvent('warning', `Attempt to freeze owner/mod/bot by ${commandSender.username}.`);
         return;
    }

    try {
        const initialPosition = await bot.room.players.position(targetUserId); // Get CURRENT position
        if (initialPosition) {
            frozenUsers.locked[targetUserId] = initialPosition; // Store userId -> Position in locked list
            await saveJson(config.permissionFiles.frozenUsers, frozenUsers); // Save to disk
            await bot.message.send(`@${commandSender.username} ${targetUser.username} has been frozen at their current location.`);
            logEvent('botAction', `${targetUser.username} frozen by ${commandSender.username} at ${initialPosition.x},${initialPosition.y},${initialPosition.z}.`);
        } else {
             await bot.message.send(`@${commandSender.username} Could not find ${targetUser.username}'s current position to freeze.`);
        }
    } catch (error) {
        await bot.message.send(`@${commandSender.username} Failed to freeze ${targetUser.username}: ${error.message}`);
        logEvent('error', `Failed to freeze ${targetUser.username}: ${error.message}`);
    }
}

async function handleUnfreezeCommand(commandSender, targetUserId) {
    logEvent('commandLog', `User ${commandSender.username} requested to unfreeze ${targetUserId}.`);
    if (!frozenUsers.locked[targetUserId]) {
        await bot.message.send(`@${commandSender.username} User is not frozen.`);
        return;
    }
    const targetUser = {id: targetUserId, username: await bot.room.players.username(targetUserId)};
    delete frozenUsers.locked[targetUserId];
    await saveJson(config.permissionFiles.frozenUsers, frozenUsers);
    await bot.message.send(`@${commandSender.username} ${targetUser.username} has been unfrozen.`);
    logEvent('botAction', `${targetUser.username} unfrozen by ${commandSender.username}.`);
}

async function handleKickCommand(commandSender, targetUserId) {
    logEvent('commandLog', `User ${commandSender.username} requested to kick ${targetUserId}.`);
    const targetUser = {id: targetUserId, username: await bot.room.players.username(targetUserId)};
    if(getRole(targetUserId) === 'owner' || getRole(targetUserId) === 'mod' || targetUserId === bot.info.user.id) {
         await bot.message.send(`@${commandSender.username} Cannot kick owner/mod/bot.`);
         logEvent('warning', `Attempt to kick owner/mod/bot by ${commandSender.username}.`);
         return;
    }
    try {
        await bot.player.kick(targetUserId);
        await bot.message.send(`@${commandSender.username} Kicked ${targetUser.username} from the room.`);
        logEvent('botAction', `Kicked ${targetUser.username} by ${commandSender.username}.`);
    } catch (error) {
        await bot.message.send(`@${commandSender.username} Failed to kick ${targetUser.username}: ${error.message}`);
        logEvent('error', `Failed to kick ${targetUser.username}: ${error.message}`);
    }
}

async function handleBanCommand(commandSender, targetUserId) {
    logEvent('commandLog', `User ${commandSender.username} requested to ban ${targetUserId}.`);
    const targetUser = {id: targetUserId, username: await bot.room.players.username(targetUserId)};
    if(getRole(targetUserId) === 'owner' || getRole(targetUserId) === 'mod' || targetUserId === bot.info.user.id) {
         await bot.message.send(`@${commandSender.username} Cannot ban owner/mod/bot.`);
         logEvent('warning', `Attempt to ban owner/mod/bot by ${commandSender.username}.`);
         return;
    }
    try {
        await bot.player.ban(targetUserId, 3600); // 1 hour = 3600 seconds
        await bot.message.send(`@${commandSender.username} Banned ${targetUser.username} for 1 hour.`);
        logEvent('botAction', `Banned ${targetUser.username} for 1 hour by ${commandSender.username}.`);
    } catch (error) {
        await bot.message.send(`@${commandSender.username} Failed to ban ${targetUser.username}: ${error.message}`);
        logEvent('error', `Failed to ban ${targetUser.username}: ${error.message}`);
    }
}

async function handleMuteCommand(commandSender, targetUserId) {
    logEvent('commandLog', `User ${commandSender.username} requested to mute ${targetUserId}.`);
    const targetUser = {id: targetUserId, username: await bot.room.players.username(targetUserId)};
     if(getRole(targetUserId) === 'owner' || getRole(targetUserId) === 'mod' || targetUserId === bot.info.user.id) {
         await bot.message.send(`@${commandSender.username} Cannot mute owner/mod/bot.`);
         logEvent('warning', `Attempt to mute owner/mod/bot by ${commandSender.username}.`);
         return;
    }
    try {
        await bot.player.mute(targetUserId, 3600); // 1 hour = 3600 seconds
        await bot.message.send(`@${commandSender.username} Muted ${targetUser.username} for 1 hour.`);
        logEvent('botAction', `Muted ${targetUser.username} for 1 hour by ${commandSender.username}.`);
    } catch (error) {
        await bot.message.send(`@${commandSender.username} Failed to mute ${targetUser.username}: ${error.message}`);
        logEvent('error', `Failed to mute ${targetUser.username}: ${error.message}`);
    }
}

async function handleInviteAllCommand(user) {
    logEvent('commandLog', `User ${user.username} requested to invite all users.`);
    try {
        const players = await bot.room.players.get();
        let inviteCount = 0;
        // Get all existing DM conversations the bot is part of
        // Note: bot.inbox.conversations.get() returns an object with a 'conversations' key
        const allConversationsResponse = await bot.inbox.conversations.get();
        const allConversations = allConversationsResponse.conversations || []; // Ensure it's an array

        const conversationsMap = new Map(); // Map user.id to conversation_id
        for(const conv of allConversations) {
            if (conv.member_ids && conv.member_ids.length === 2) { // Direct DM
                const otherMemberId = conv.member_ids.find(id => id !== bot.info.user.id);
                if (otherMemberId) {
                    conversationsMap.set(otherMemberId, conv.id);
                }
            }
        }

        for (const [playerUser, playerPosition] of players) {
            if (playerUser.id === bot.info.user.id) continue;
            
            const conversationId = conversationsMap.get(playerUser.id);
            if (conversationId) {
                try {
                    await bot.invite.send(conversationId, config.botAuth.roomId);
                    logEvent('debug', `Sent invite to ${playerUser.username} via DM.`);
                    inviteCount++;
                    await new Promise(resolve => setTimeout(resolve, 500)); // Small delay
                } catch (e) {
                    logEvent('error', `Failed to send invite to ${playerUser.username} (DM): ${e.message}`);
                }
            } else {
                logEvent('debug', `No active DM conversation with ${playerUser.username} to send invite.`);
            }
        }
        await bot.message.send(`@${user.username} Attempted to send invites via DM to ${inviteCount} users who have previously messaged the bot.`);
        logEvent('botAction', `Attempted to send invites to ${inviteCount} users by ${user.username}.`);
    } catch (error) {
        await bot.message.send(`@${user.username} Failed to send invites: ${error.message}`);
        logEvent('error', `Failed to send invites: ${error.message}`);
    }
}

async function handleBoostCommand(user, amount) {
    logEvent('commandLog', `User ${user.username} requested to buy ${amount} boosts.`);
    try {
        // Passing the explicit string 'bot_wallet_only' as per SDK usage
        const result = await bot.wallet.boost.buy('bot_wallet_only', amount); 
        if (result === 'success') {
            await bot.message.send(`@${user.username} Successfully bought ${amount} room boosts!`);
            logEvent('botAction', `Bought ${amount} boosts for ${user.username}.`);
        } else if (result === 'insufficient_funds') {
            await bot.message.send(`@${user.username} Bot has insufficient funds to buy boosts.`);
        } else {
            // Catch any other unexpected result strings
            await bot.message.send(`@${user.username} Failed to buy boosts: ${result}`);
        }
    } catch (error) {
        await bot.message.send(`@${user.username} Error buying boosts: ${error.message}`);
        logEvent('error', `Error buying boosts for ${user.username}: ${error.stack}`); // Log full stack for debug
    }
}

async function handleVoiceCommand(user, amount) {
    logEvent('commandLog', `User ${user.username} requested to buy ${amount} voice time.`);
    try {
        // Passing the explicit string 'bot_wallet_only' as per SDK usage
        const result = await bot.wallet.voice.buy('bot_wallet_only', amount);
        if (result === 'success') {
            await bot.message.send(`@${user.username} Successfully bought ${amount} voice time!`);
            logEvent('botAction', `Bought ${amount} voice time for ${user.username}.`);
        } else if (result === 'insufficient_funds') {
            await bot.message.send(`@${user.username} Bot has insufficient funds to buy voice time.`);
        } else {
             // Catch any other unexpected result strings
            await bot.message.send(`@${user.username} Failed to buy voice time: ${result}`);
        }
    } catch (error) {
        await bot.message.send(`@${user.username} Error buying voice time: ${error.message}`);
        logEvent('error', `Error buying voice time for ${user.username}: ${error.stack}`); // Log full stack for debug
    }
}

async function handleEquipCommand(user, itemId) {
    logEvent('commandLog', `User ${user.username} requested to equip ${itemId}.`);
    try {
         // For safety, let's assume the user wants the bot to wear the item itself.
        const outfit = await bot.player.outfit.get(bot.info.user.id);
        const newItem = { type: 'clothing', amount: 1, id: itemId.trim(), account_bound: false, active_palette: 0 }; 
        
        // To replace an existing item of the same type/category (e.g., equip new pants, old pants are removed)
        // This is a simplistic approach, might need refinement for complex outfit logic.
        const categoryIdentifier = newItem.id.split('-')[0]; // e.g., "pants", "shirt"
        const filteredOutfit = outfit.filter(item => item && !item.id.toLowerCase().startsWith(categoryIdentifier.toLowerCase()));
        
        const updatedOutfit = [...filteredOutfit, newItem];

        await bot.outfit.change(updatedOutfit);
        await bot.message.send(`@${user.username} Equipped item: ${itemId}`);
        logEvent('botAction', `Bot equipped ${itemId} by ${user.username}.`);
    } catch (error) {
        await bot.message.send(`@${user.username} Failed to equip item: ${error.message}. Bot may not own this item or it's invalid.`);
        logEvent('error', `Failed to equip ${itemId} for ${user.username}: ${error.message}`);
    }
}

async function handleRemoveCommand(user, category) {
    logEvent('commandLog', `User ${user.username} requested to remove item in category ${category}.`);
    try {
        const currentOutfit = await bot.player.outfit.get(bot.info.user.id);
        // Case-insensitive removal
        const filteredOutfit = currentOutfit.filter(item => item && !item.id.toLowerCase().includes(category.toLowerCase()));
        
        await bot.outfit.change(filteredOutfit);
        await bot.message.send(`@${user.username} Removed items matching category: ${category}`);
        logEvent('botAction', `Bot removed items in ${category} by ${user.username}.`);
    } catch (error) {
        await bot.message.send(`@${user.username} Failed to remove item: ${error.message}. Category may be invalid or items are not removable.`);
        logEvent('error', `Failed to remove ${category} for ${user.username}: ${error.message}`);
    }
}

async function handleColorCommand(user, category, index) {
    logEvent('commandLog', `User ${user.username} requested to change color for ${category} to index ${index}.`);
    try {
        const bodyPartMap = {
            "hair": "hair", "eyes": "eye", "eyebrow": "eyebrow", "lips": "mouth", "skin": "body"
        };
        const mappedCategory = bodyPartMap[category.toLowerCase()];
        
        if (mappedCategory) {
            // The `bot.outfit.color` method already handles updating the bot's outfit with the new color.
            await bot.outfit.color(mappedCategory, index);
            await bot.message.send(`@${user.username} Changed ${category} color to index ${index}.`);
            logEvent('botAction', `Bot changed ${category} color to ${index} by ${user.username}.`);
        } else {
           await bot.message.send(`@${user.username} Invalid category. Supported: hair, eyes, eyebrow, lips, skin.`);
        }
    } catch (error) {
        await bot.message.send(`@${user.username} Failed to change color: ${error.message}`);
        logEvent('error', `Failed to change ${category} color for ${user.username}: ${error.message}`);
    }
}

async function handleCopyOutfitCommand(user, targetUserId) {
    logEvent('commandLog', `User ${user.username} requested to copy outfit from ${targetUserId}.`);
    try {
        const targetOutfit = await bot.player.outfit.get(targetUserId);
        if (targetOutfit && targetOutfit.length > 0) {
            await bot.outfit.change(targetOutfit);
            await bot.message.send(`@${user.username} Copied outfit from ${await bot.room.players.username(targetUserId)}.`);
            logEvent('botAction', `Bot copied outfit from ${await bot.room.players.username(targetUserId)} by ${user.username}.`);
        } else {
            await bot.message.send(`@${user.username} Could not get outfit from that user or user has no outfit equipped.`);
        }
    } catch (error) {
        await bot.message.send(`@${user.username} Failed to copy outfit: ${error.message}`);
        logEvent('error', `Failed to copy outfit for ${user.username}: ${error.message}`);
    }
}

// --- New Features (Requested by User) ---

// Read Full Text (Long Message Send)
async function handleLongSayCommand(user, text, chatType, conversationId = null) {
    logEvent('commandLog', `User ${user.username} requested long message send.`);
    if (!config.features.enableLongMessageSend) {
        await reply(user, `Long message sending is currently disabled.`, chatType, conversationId);
        return;
    }

    const MAX_MESSAGE_LENGTH = 120; // Highrise public message character limit
    const words = text.split(' ');
    let currentChunk = '';
    const lines = [];

    for (const word of words) {
        // Check if adding the next word (plus a space if not first word in chunk) exceeds limit
        if ((currentChunk ? currentChunk.length + 1 : 0) + word.length <= MAX_MESSAGE_LENGTH) {
            currentChunk += (currentChunk ? ' ' : '') + word;
        } else {
            // Current chunk is full, push it and start a new one with the current word
            lines.push(currentChunk);
            currentChunk = word;
        }
    }
    // Push the last chunk if it exists
    if (currentChunk) {
        lines.push(currentChunk);
    }
    
    if (lines.length === 0 && text.length > 0) { 
        // Fallback for single very long words that exceed MAX_MESSAGE_LENGTH
        // In this case, just send the entire word, Highrise might truncate it on its end
        // or split it automatically if its internal logic allows.
        lines.push(text);
    }

    if (lines.length === 0 && text.length === 0) { // If original text was empty
        await reply(user, `No text provided for !longsay.`, chatType, conversationId);
        return;
    }

    for (let i = 0; i < lines.length; i++) {
        try {
            if (chatType === 'public') {
                await bot.message.send(lines[i]);
            } else if (chatType === 'dm' && conversationId) {
                await bot.direct.send(conversationId, lines[i]);
            }
            await new Promise(resolve => setTimeout(resolve, 1000)); // Delay between messages for rate limits
        } catch (error) {
            logEvent('error', `Error sending long message part ${i+1}: ${error.message}`);
            await reply(user, `Failed to send part of the message.`, chatType, conversationId);
            break;
        }
    }
    logEvent('botAction', `Sent long message (${lines.length} parts) initiated by ${user.username}.`);
}

// Read All File Content
async function handleSendFileContentCommand(user, fileName, chatType, conversationId = null) {
    logEvent('commandLog', `User ${user.username} requested to send file content: ${fileName}.`);
    if (!config.features.enableFileContentSend) {
         await reply(user, `Sending file content is currently disabled for security reasons.`, chatType, conversationId);
         return;
    }

    // Restrict to data folder for security
    const filePath = `./data/${fileName}`;
    try {
        const fileContent = await fs.readFile(filePath, 'utf8');
        logEvent('botAction', `Read content from ${filePath}. Sending...`);
        await handleLongSayCommand(user, fileContent, chatType, conversationId); // Reuse long message sender
    } catch (error) {
        if (error.code === 'ENOENT') {
            await reply(user, `@${user.username} File '${fileName}' not found in data folder.`, chatType, conversationId);
            logEvent('warning', `File '${fileName}' not found for ${user.username}.`);
        } else {
            await reply(user, `@${user.username} Error reading file '${fileName}': ${error.message}`, chatType, conversationId);
            logEvent('error', `Error reading file '${fileName}' for ${user.username}: ${error.message}`);
        }
    }
}

async function handleEmoteListCommand(user, conversationId) {
    logEvent('commandLog', `User ${user.username} requested emote list.`);
    
    // Join emote names with newline
    const emoteNames = Object.keys(config.emoteDefinitions).join('\n');
    const emoteListMessage = `${messages.emoteListHeader}${emoteNames}`;

    // Using handleLongSayCommand to send the list in chunks if needed, respecting DM limits
    await handleLongSayCommand(user, emoteListMessage, 'dm', conversationId);
    logEvent('botAction', `Sent emote list to ${user.username}.`);
}


// AI Response Function (using OpenRouter)
async function getAiResponse(prompt) {
    try {
        const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
            model: 'mistralai/mistral-7b-instruct', // or any other model you prefer
            messages: [
                { role: 'user', content: prompt }
            ]
        }, {
            headers: {
                'Authorization': `Bearer ${config.openRouterApiKey}`,
                'Content-Type': 'application/json'
            }
        });
        return response.data.choices[0].message.content;
    } catch (error) {
        logEvent('error', `OpenRouter AI Error: ${error.message}`);
        if (error.response) {
            logEvent('error', `OpenRouter API Response Error: ${JSON.stringify(error.response.data)}`);
        }
        return "Failed to get a response from AI. Please try again later.";
    }
}

// --- Start the bot ---
main();

// --- Global Error Handling ---
process.on('unhandledRejection', (reason, promise) => {
    logEvent('error', `[ANTI-CRASH] Unhandled Rejection: ${reason}\nPromise: ${promise}`);
    // Optionally, implement graceful shutdown or restart logic here
});

process.on('uncaughtException', (err, origin) => {
    logEvent('error', `[ANTI-CRASH] Uncaught Exception: ${err}\nOrigin: ${origin}`);
    // Optionally, implement graceful shutdown or restart logic here
    process.exit(1); // Exit with a failure code
});
