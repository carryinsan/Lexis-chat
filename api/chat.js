/**
 * api/chat.js - Zero-Duplication & Ultra Fail-Safe Ephemeral Transit Pipeline
 * * Features:
 * 1. Deterministic Idempotency Guard (Redis SET NX + DB UNIQUE constraint)
 * 2. Real-Time AI Safety Scanning integration via api/security.js
 * 3. ACK (Acknowledgment) & Instant Cloud Purge Protocol
 * 4. Automatic Exponential Backoff Retries for Network Resiliency
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { Redis } from 'https://esm.sh/@upstash/redis@1';
import { analyzeActivityWithGPTOSS } from './security.js';

// Immutable Backend Configuration Credentials
const SUPABASE_URL = "https://yqadyurhepgzxnniwktd.supabase.co";
const SUPABASE_KEY = "EyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlxYWR5dXJoZXBnenhubml3a3RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3OTg3NTY1NywiZXhwIjoyMDk1NDUxNjU3fQ.U10IjMc7Pp-droJiQCFGZ-T1kA8tZXFkLqlN2EqeUqI";
const UPSTASH_URL = "https://one-dog-130412.upstash.io";
const UPSTASH_TOKEN = "gQAAAAAAAf1sAAIgcDE4YjcyZTQzYWM3NTc0YjI2ODdhYjA3MmU1ODBkMTQwNQ";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const redis = new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN });

/**
 * Executes an async operation with exponential backoff retry logic.
 * Retries up to maxAttempts times with delays of 1s, 2s, 4s, 8s, 16s.
 */
async function executeWithRetry(fn, maxAttempts = 5) {
    let attempt = 0;
    while (attempt < maxAttempts) {
        try {
            return await fn();
        } catch (err) {
            attempt++;
            if (attempt >= maxAttempts) throw err;
            const delay = Math.pow(2, attempt - 1) * 1000;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

/**
 * Generates a deterministic idempotency key for deduplication.
 * Format: hash(senderId + timestamp + nonce)
 */
export async function generateIdempotencyKey(senderId, timestamp, nonce) {
    const raw = `${senderId}:${timestamp}:${nonce}`;
    const msgUint8 = new TextEncoder().encode(raw);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Sends a message into the ephemeral transit buffer.
 * Enforces deduplication via Redis and PostgreSQL unique constraints.
 */
export async function sendMessage(payload) {
    const { 
        senderId, 
        receiverId, 
        encryptedPayload, 
        rawContentForModeration = '', 
        deviceFingerprint, 
        mediaMetadata = null, 
        nonce = crypto.randomUUID(),
        timestamp = Date.now()
    } = payload;

    if (!senderId || !receiverId || !encryptedPayload) {
        return { success: false, error: "Required message parameters are missing." };
    }

    try {
        const idempotencyKey = await generateIdempotencyKey(senderId, timestamp, nonce);

        // 1. Atomic Redis Deduplication Lock (Prevents rapid-fire duplicate requests)
        const isNewMessage = await executeWithRetry(() => 
            redis.set(`dedup:${idempotencyKey}`, "1", { nx: true, ex: 300 })
        );

        if (!isNewMessage) {
            return { 
                success: true, 
                duplicate: true, 
                idempotencyKey,
                message: "Duplicate transmission ignored by server guardrail." 
            };
        }

        // 2. Groq GPT-OSS-20B Real-Time Moderation Check
        if (rawContentForModeration && rawContentForModeration.trim().length > 0) {
            const aiCheck = await analyzeActivityWithGPTOSS(senderId, deviceFingerprint, {
                text: rawContentForModeration,
                action: 'chat_message',
                metadata: { receiverId, mediaMetadata }
            });

            if (!aiCheck.safe) {
                return { 
                    success: false, 
                    banned: true, 
                    error: `Message blocked by security shield: ${aiCheck.reason}` 
                };
            }
        }

        // 3. Insert into Supabase Ephemeral Buffer Database
        const dbResult = await executeWithRetry(async () => {
            const { data, error } = await supabase
                .from('message_buffer')
                .insert([{
                    idempotency_key: idempotencyKey,
                    sender_id: senderId,
                    receiver_id: receiverId,
                    encrypted_payload: encryptedPayload,
                    media_metadata: mediaMetadata,
                    is_delivered: false
                }])
                .select()
                .single();

            if (error) {
                // Handle ON CONFLICT unique key collisions gracefully
                if (error.code === '23505') {
                    return { duplicate: true };
                }
                throw error;
            }
            return { data };
        });

        if (dbResult.duplicate) {
            return { success: true, duplicate: true, idempotencyKey };
        }

        return { 
            success: true, 
            idempotencyKey, 
            messageId: dbResult.data.id,
            timestamp: dbResult.data.created_at
        };

    } catch (err) {
        console.error("Critical error in sendMessage pipeline:", err);
        return { success: false, error: "Message transit failed due to server error." };
    }
}

/**
 * Acknowledges receipt of a message and hard-deletes it from the cloud database
 * to maintain 0 MB long-term storage overhead.
 */
export async function acknowledgeAndPurgeMessage(messageId, receiverId) {
    if (!messageId || !receiverId) {
        return { success: false, error: "Missing messageId or receiverId." };
    }

    try {
        const result = await executeWithRetry(async () => {
            const { error } = await supabase
                .from('message_buffer')
                .delete()
                .eq('id', messageId)
                .eq('receiver_id', receiverId);

            if (error) throw error;
            return { success: true };
        });

        return result;
    } catch (err) {
        console.error("Error purging ephemeral message:", err);
        return { success: false, error: "Failed to purge transient cloud message." };
    }
}

/**
 * Batch acknowledges and purges multiple messages in a single query.
 */
export async function batchAcknowledgeAndPurge(messageIds, receiverId) {
    if (!Array.isArray(messageIds) || messageIds.length === 0 || !receiverId) {
        return { success: true, count: 0 };
    }

    try {
        await executeWithRetry(async () => {
            const { error } = await supabase
                .from('message_buffer')
                .delete()
                .in('id', messageIds)
                .eq('receiver_id', receiverId);

            if (error) throw error;
        });

        return { success: true, count: messageIds.length };
    } catch (err) {
        console.error("Error in batch purge:", err);
        return { success: false, error: "Batch purge execution failed." };
    }
}

/**
 * Fetches all pending transient inbox messages for a connecting client.
 */
export async function fetchTransientInbox(receiverId) {
    if (!receiverId) return { data: [], error: "Missing receiver ID" };

    try {
        const data = await executeWithRetry(async () => {
            const { data: messages, error } = await supabase
                .from('message_buffer')
                .select('*')
                .eq('receiver_id', receiverId)
                .order('created_at', { ascending: true });

            if (error) throw error;
            return messages || [];
        });

        return { data };
    } catch (err) {
        console.error("Error fetching transient inbox:", err);
        return { data: [], error: err.message };
    }
                                                  }
