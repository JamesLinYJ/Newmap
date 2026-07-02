import type { ConversationItem } from '../schemas/types.js'

export function latestAssistantText(items: ConversationItem[]): string {
    for (const item of [...items].reverse()) {
        if (item.itemType !== 'message' || item.role !== 'assistant')
            continue;
        const text = (item.body ?? '').trim();
        if (text)
            return text;
    }
    return '';
}
export function summarizeAssistantText(text: string, maxChars = 240): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxChars)
        return normalized;
    return normalized.slice(0, maxChars - 1).trimEnd() + '...';
}
export function buildConversationDigest(createdAt: string, userQuery: string, items: ConversationItem[]) {
    const assistantText = latestAssistantText(items);
    if (!assistantText)
        return null;
    return {
        createdAt,
        userQuery,
        assistantSummary: summarizeAssistantText(assistantText),
    };
}
