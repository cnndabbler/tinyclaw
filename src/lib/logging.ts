import fs from 'fs';
import path from 'path';
import { LOG_FILE, EVENTS_DIR } from './config';

export function log(level: string, message: string): void {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}\n`;
    console.log(logMessage.trim());
    fs.appendFileSync(LOG_FILE, logMessage);
}

/**
 * Pluggable event listeners.  The API server registers a listener so that
 * every event emitted by the queue processor is also broadcast over SSE.
 */
type EventListener = (type: string, data: Record<string, unknown>) => void;
const eventListeners: EventListener[] = [];

/** Register a listener that is called on every emitEvent. */
export function onEvent(listener: EventListener): void {
    eventListeners.push(listener);
}

/**
 * Emit a structured event for the team visualizer TUI.
 * Events are written as JSON files to EVENTS_DIR, watched by the visualizer.
 * Any registered listeners (e.g. SSE broadcast) are also notified.
 */
export function emitEvent(type: string, data: Record<string, unknown>): void {
    try {
        if (!fs.existsSync(EVENTS_DIR)) {
            fs.mkdirSync(EVENTS_DIR, { recursive: true });
        }
        const event = { type, timestamp: Date.now(), ...data };
        const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
        fs.writeFileSync(path.join(EVENTS_DIR, filename), JSON.stringify(event) + '\n');
    } catch {
        // Visualizer events are best-effort; never break the queue processor
    }

    // Notify listeners (best-effort)
    for (const listener of eventListeners) {
        try { listener(type, data); } catch { /* never break the queue processor */ }
    }
}
