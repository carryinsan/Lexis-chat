/**
 * api/contacts.js - Lexis Identity Generation (@lexis.chat.app) & Address Book Operations
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = "https://yqadyurhepgzxnniwktd.supabase.co";
const SUPABASE_KEY = "EyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlxYWR5dXJoZXBnenhubml3a3RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3OTg3NTY1NywiZXhwIjoyMDk1NDUxNjU3fQ.U10IjMc7Pp-droJiQCFGZ-T1kA8tZXFkLqlN2EqeUqI";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/**
 * Formats and normalizes any raw input into standard username@lexis.chat.app handle
 */
export function formatLexisId(inputHandle) {
    if (!inputHandle) return '';
    let clean = inputHandle.trim().toLowerCase();
    // Remove unwanted spaces and invalid special characters
    clean = clean.replace(/[^a-z0-9_.]/g, '');
    if (clean.endsWith('@lexis.chat.app')) {
        return clean;
    }
    // Remove trailing @ if present
    clean = clean.replace(/@+$/, '');
    return `${clean}@lexis.chat.app`;
}

/**
 * Generates a guaranteed unique Lexis ID for new registration
 */
export async function generateUniqueLexisId(preferredName = '') {
    let base = preferredName.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (!base || base.length < 3) {
        base = `user_${Math.floor(1000 + Math.random() * 9000)}`;
    }

    let candidate = `${base}@lexis.chat.app`;
    let isUnique = false;
    let counter = 1;

    while (!isUnique && counter <= 10) {
        const { data } = await supabase
            .from('profiles')
            .select('id')
            .eq('lexis_id', candidate)
            .maybeSingle();

        if (!data) {
            isUnique = true;
        } else {
            candidate = `${base}_${counter}@lexis.chat.app`;
            counter++;
        }
    }

    return candidate;
}

/**
 * Search for a user profile by exact Lexis ID (e.g., john@lexis.chat.app)
 */
export async function searchContact(lexisId) {
    const targetLexisId = formatLexisId(lexisId);
    if (!targetLexisId) {
        return { error: "Please provide a valid Lexis ID." };
    }

    try {
        const { data: profile, error } = await supabase
            .from('profiles')
            .select('id, lexis_id, display_name, avatar_url, public_key, is_banned')
            .eq('lexis_id', targetLexisId)
            .maybeSingle();

        if (error) {
            console.error("Error searching contact:", error);
            return { error: "Failed to execute contact search." };
        }

        if (!profile) {
            return { error: `No user found with Lexis ID: ${targetLexisId}` };
        }

        if (profile.is_banned) {
            return { error: "This user profile has been suspended." };
        }

        return { 
            data: {
                id: profile.id,
                lexis_id: profile.lexis_id,
                display_name: profile.display_name,
                avatar_url: profile.avatar_url,
                public_key: profile.public_key
            }
        };
    } catch (err) {
        console.error("Exception in searchContact:", err);
        return { error: "An unexpected error occurred during search." };
    }
}

/**
 * Add a contact to a user's address book
 */
export async function addContact(userId, contactId, customName = '') {
    if (!userId || !contactId) {
        return { error: "Invalid user or contact ID." };
    }

    if (userId === contactId) {
        return { error: "You cannot add your own Lexis ID to contacts." };
    }

    try {
        // Verify target contact is active
        const { data: contactProfile } = await supabase
            .from('profiles')
            .select('is_banned, display_name')
            .eq('id', contactId)
            .single();

        if (contactProfile && contactProfile.is_banned) {
            return { error: "Cannot add a suspended account." };
        }

        // Insert contact pair with ON CONFLICT DO NOTHING (idempotent)
        const { data, error } = await supabase
            .from('contacts')
            .upsert([{
                user_id: userId,
                contact_id: contactId,
                custom_name: customName || contactProfile?.display_name || ''
            }], { onConflict: 'user_id,contact_id' })
            .select()
            .single();

        if (error) {
            console.error("Error adding contact:", error);
            return { error: "Failed to add contact." };
        }

        return { success: true, data };
    } catch (err) {
        console.error("Exception in addContact:", err);
        return { error: "Server error while saving contact." };
    }
}

/**
 * Fetch complete contact list for a specific user
 */
export async function getContacts(userId) {
    if (!userId) return { data: [] };

    try {
        const { data, error } = await supabase
            .from('contacts')
            .select(`
                id,
                custom_name,
                created_at,
                profiles:contact_id (
                    id, 
                    lexis_id, 
                    display_name, 
                    avatar_url, 
                    public_key, 
                    is_banned
                )
            `)
            .eq('user_id', userId);

        if (error) {
            console.error("Error fetching contacts:", error);
            return { data: [], error: error.message };
        }

        // Filter out suspended profiles and format response
        const activeContacts = (data || [])
            .filter(item => item.profiles && !item.profiles.is_banned)
            .map(item => ({
                contact_record_id: item.id,
                id: item.profiles.id,
                lexis_id: item.profiles.lexis_id,
                display_name: item.custom_name || item.profiles.display_name,
                avatar_url: item.profiles.avatar_url,
                public_key: item.profiles.public_key
            }));

        return { data: activeContacts };
    } catch (err) {
        console.error("Exception in getContacts:", err);
        return { data: [] };
    }
}

/**
 * Remove a contact from a user's address book
 */
export async function removeContact(userId, contactId) {
    if (!userId || !contactId) return { success: false };

    try {
        const { error } = await supabase
            .from('contacts')
            .delete()
            .eq('user_id', userId)
            .eq('contact_id', contactId);

        if (error) {
            console.error("Error removing contact:", error);
            return { success: false, error: error.message };
        }

        return { success: true };
    } catch (err) {
        console.error("Exception in removeContact:", err);
        return { success: false };
    }
                    }
