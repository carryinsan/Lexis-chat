/**
 * api/addons.js - Upstash Redis Real-time Heartbeat, Presence & Typing Sentinel
 * * Features:
 * 1. Ultra-Lightweight Online/Offline Presence Heartbeat (45s TTL)
 * 2. Typing Indicator Broadcast (5s TTL)
 * 3. Batch Contact Presence Fetcher (Single HTTP call for entire address book)
 * 4. Automatic Error Containment (Fail-safe defaults to prevent UI crashes)
 */
import { Redis } from 'https://esm.sh/@upstash/redis@1';

const UPSTASH_URL = "https://one-dog-130412.upstash.io";
const UPSTASH_TOKEN = "gQAAAAAAAf1sAAIgcDE4YjcyZTQzYWM3NTc0YjI2ODdhYjA3MmU1ODBkMTQwNQ";

const redis = new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN });

/**
 * Transmits presence heartbeat for active user.
 * Sets presence:<userId> = "online" with 45-second TTL.
 */
export async function sendHeartbeat(userId) {
    if (!userId) return;

    try {
        const timestamp = Date.now().toString();
        // Pipeline batch commands to save Redis requests
        const pipeline = redis.pipeline();
        pipeline.set(`presence:${userId}`, "online", { ex: 45 });
        pipeline.set(`last_seen:${userId}`, timestamp);
        await pipeline.exec();
    } catch (err) {
        console.error("Presence heartbeat error:", err);
    }
}

/**
 * Sets or clears typing indicator status for a active chat conversation.
 */
export async function setTypingState(chatId, userId, isTyping) {
    if (!chatId || !userId) return;

    const key = `typing:${chatId}:${userId}`;
    try {
        if (isTyping) {
            await redis.set(key, "1", { ex: 5 });
        } else {
            await redis.del(key);
        }
    } catch (err) {
        console.error("Typing indicator update error:", err);
    }
}

/**
 * Queries presence, last-seen timestamp, and typing status for a single contact.
 */
export async function getContactStatus(contactId, currentUserId) {
    if (!contactId || !currentUserId) {
        return { online: false, lastSeen: null, typing: false };
    }

    try {
        const chatId = [currentUserId, contactId].sort().join('_');
        const typingKey = `typing:${chatId}:${contactId}`;

        // Single pipeline round-trip
        const pipeline = redis.pipeline();
        pipeline.get(`presence:${contactId}`);
        pipeline.get(`last_seen:${contactId}`);
        pipeline.get(typingKey);
        
        const [presence, lastSeen, typing] = await pipeline.exec();

        return {
            online: presence === "online",
            lastSeen: lastSeen ? parseInt(lastSeen, 10) : null,
            typing: Boolean(typing)
        };
    } catch (err) {
        console.error("Error fetching contact status:", err);
        return { online: false, lastSeen: null, typing: false };
    }
}

/**
 * Batch queries presence and last-seen status for an array of contacts.
 * Drastically reduces Redis command usage on free tier.
 */
export async function batchGetContactsStatus(contactIds) {
    if (!Array.isArray(contactIds) || contactIds.length === 0) {
        return {};
    }

    try {
        const pipeline = redis.pipeline();
        contactIds.forEach(id => {
            pipeline.get(`presence:${id}`);
            pipeline.get(`last_seen:${id}`);
        });

        const results = await pipeline.exec();
        const statuses = {};

        for (let i = 0; i < contactIds.length; i++) {
            const contactId = contactIds[i];
            const presence = results[i * 2];
            const lastSeen = results[i * 2 + 1];

            statuses[contactId] = {
                online: presence === "online",
                lastSeen: lastSeen ? parseInt(lastSeen, 10) : null
            };
        }

        return statuses;
    } catch (err) {
        console.error("Batch status query error:", err);
        return {};
    }
}
