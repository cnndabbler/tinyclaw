#!/usr/bin/env node
/**
 * Queue Processor - Handles messages from all channels (WhatsApp, Telegram, etc.)
 *
 * Supports multi-agent routing:
 *   - Messages prefixed with @agent_id are routed to that agent
 *   - Unrouted messages go to the "default" agent
 *   - Each agent has its own provider, model, working directory, and system prompt
 *   - Conversation isolation via per-agent working directories
 *
 * Team conversations use queue-based message passing:
 *   - Agent mentions ([@teammate: message]) become new messages in the queue
 *   - Each agent processes messages naturally via its own promise chain
 *   - Conversations complete when all branches resolve (no more pending mentions)
 */

import fs from 'fs';
import path from 'path';
import http from 'http';
import { MessageData, ResponseData, QueueFile, ChainStep, Conversation, TeamConfig, Settings } from './lib/types';
import {
    QUEUE_INCOMING, QUEUE_OUTGOING, QUEUE_PROCESSING,
    LOG_FILE, EVENTS_DIR, CHATS_DIR, FILES_DIR, SETTINGS_FILE,
    getSettings, getAgents, getTeams
} from './lib/config';
import { log, emitEvent } from './lib/logging';
import { parseAgentRouting, findTeamForAgent, getAgentResetFlag, extractTeammateMentions } from './lib/routing';
import { invokeAgent } from './lib/invoke';
import { jsonrepair } from 'jsonrepair';

/** Parse JSON with automatic repair for malformed content (e.g. bad escapes). */
function safeParseJSON<T = unknown>(raw: string, label?: string): T {
    try {
        return JSON.parse(raw);
    } catch {
        log('WARN', `Invalid JSON${label ? ` in ${label}` : ''}, attempting auto-repair`);
        return JSON.parse(jsonrepair(raw));
    }
}

// Ensure directories exist
[QUEUE_INCOMING, QUEUE_OUTGOING, QUEUE_PROCESSING, FILES_DIR, path.dirname(LOG_FILE)].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// Files currently queued in a promise chain — prevents duplicate processing across ticks
const queuedFiles = new Set<string>();

// Active conversations — tracks in-flight team message passing
const conversations = new Map<string, Conversation>();

const MAX_CONVERSATION_MESSAGES = 50;
const LONG_RESPONSE_THRESHOLD = 4000;

/**
 * If a response exceeds the threshold, save full text as a .md file
 * and return a truncated preview with the file attached.
 */
function handleLongResponse(
    response: string,
    existingFiles: string[]
): { message: string; files: string[] } {
    if (response.length <= LONG_RESPONSE_THRESHOLD) {
        return { message: response, files: existingFiles };
    }

    // Save full response as a .md file
    const filename = `response_${Date.now()}.md`;
    const filePath = path.join(FILES_DIR, filename);
    fs.writeFileSync(filePath, response);
    log('INFO', `Long response (${response.length} chars) saved to ${filename}`);

    // Truncate to preview
    const preview = response.substring(0, LONG_RESPONSE_THRESHOLD) + '\n\n_(Full response attached as file)_';

    return { message: preview, files: [...existingFiles, filePath] };
}

// Recover orphaned files from processing/ on startup (crash recovery)
function recoverOrphanedFiles() {
    for (const f of fs.readdirSync(QUEUE_PROCESSING).filter(f => f.endsWith('.json'))) {
        try {
            fs.renameSync(path.join(QUEUE_PROCESSING, f), path.join(QUEUE_INCOMING, f));
            log('INFO', `Recovered orphaned file: ${f}`);
        } catch (error) {
            log('ERROR', `Failed to recover orphaned file ${f}: ${(error as Error).message}`);
        }
    }
}

/**
 * Enqueue an internal (agent-to-agent) message into QUEUE_INCOMING.
 */
function enqueueInternalMessage(
    conversationId: string,
    fromAgent: string,
    targetAgent: string,
    message: string,
    originalData: MessageData
): void {
    const internalMessage: MessageData = {
        channel: originalData.channel,
        sender: originalData.sender,
        senderId: originalData.senderId,
        message,
        timestamp: Date.now(),
        messageId: originalData.messageId,
        agent: targetAgent,
        conversationId,
        fromAgent,
    };

    const filename = `internal_${conversationId}_${targetAgent}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.json`;
    fs.writeFileSync(path.join(QUEUE_INCOMING, filename), JSON.stringify(internalMessage, null, 2));
    log('INFO', `Enqueued internal message: @${fromAgent} → @${targetAgent}`);
}

/**
 * Collect files from a response text.
 */
function collectFiles(response: string, fileSet: Set<string>): void {
    const fileRegex = /\[send_file:\s*([^\]]+)\]/g;
    let match: RegExpExecArray | null;
    while ((match = fileRegex.exec(response)) !== null) {
        const filePath = match[1].trim();
        if (fs.existsSync(filePath)) fileSet.add(filePath);
    }
}

/**
 * Complete a conversation: aggregate responses, write to outgoing queue, save chat history.
 */
function completeConversation(conv: Conversation): void {
    const settings = getSettings();
    const agents = getAgents(settings);

    log('INFO', `Conversation ${conv.id} complete — ${conv.responses.length} response(s), ${conv.totalMessages} total message(s)`);
    emitEvent('team_chain_end', {
        teamId: conv.teamContext.teamId,
        totalSteps: conv.responses.length,
        agents: conv.responses.map(s => s.agentId),
    });

    // Aggregate responses
    let finalResponse: string;
    if (conv.responses.length === 1) {
        finalResponse = conv.responses[0].response;
    } else {
        finalResponse = conv.responses
            .map(step => `@${step.agentId}: ${step.response}`)
            .join('\n\n------\n\n');
    }

    // Save chat history
    try {
        const teamChatsDir = path.join(CHATS_DIR, conv.teamContext.teamId);
        if (!fs.existsSync(teamChatsDir)) {
            fs.mkdirSync(teamChatsDir, { recursive: true });
        }
        const chatLines: string[] = [];
        chatLines.push(`# Team Conversation: ${conv.teamContext.team.name} (@${conv.teamContext.teamId})`);
        chatLines.push(`**Date:** ${new Date().toISOString()}`);
        chatLines.push(`**Channel:** ${conv.channel} | **Sender:** ${conv.sender}`);
        chatLines.push(`**Messages:** ${conv.totalMessages}`);
        chatLines.push('');
        chatLines.push('------');
        chatLines.push('');
        chatLines.push(`## User Message`);
        chatLines.push('');
        chatLines.push(conv.originalMessage);
        chatLines.push('');
        for (let i = 0; i < conv.responses.length; i++) {
            const step = conv.responses[i];
            const stepAgent = agents[step.agentId];
            const stepLabel = stepAgent ? `${stepAgent.name} (@${step.agentId})` : `@${step.agentId}`;
            chatLines.push('------');
            chatLines.push('');
            chatLines.push(`## ${stepLabel}`);
            chatLines.push('');
            chatLines.push(step.response);
            chatLines.push('');
        }
        const now = new Date();
        const dateTime = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
        fs.writeFileSync(path.join(teamChatsDir, `${dateTime}.md`), chatLines.join('\n'));
        log('INFO', `Chat history saved`);
    } catch (e) {
        log('ERROR', `Failed to save chat history: ${(e as Error).message}`);
    }

    // Detect file references
    finalResponse = finalResponse.trim();
    const outboundFilesSet = new Set<string>(conv.files);
    collectFiles(finalResponse, outboundFilesSet);
    const outboundFiles = Array.from(outboundFilesSet);

    // Remove [send_file: ...] tags
    if (outboundFiles.length > 0) {
        finalResponse = finalResponse.replace(/\[send_file:\s*[^\]]+\]/g, '').trim();
    }

    // Remove [@agent: ...] tags from final response
    finalResponse = finalResponse.replace(/\[@\S+?:\s*[\s\S]*?\]/g, '').trim();

    // Handle long responses — send as file attachment
    const { message: responseMessage, files: allFiles } = handleLongResponse(finalResponse, outboundFiles);

    // Write to outgoing queue
    const responseData: ResponseData = {
        channel: conv.channel,
        sender: conv.sender,
        message: responseMessage,
        originalMessage: conv.originalMessage,
        timestamp: Date.now(),
        messageId: conv.messageId,
        files: allFiles.length > 0 ? allFiles : undefined,
    };

    const responseFile = conv.channel === 'heartbeat'
        ? path.join(QUEUE_OUTGOING, `${conv.messageId}.json`)
        : path.join(QUEUE_OUTGOING, `${conv.channel}_${conv.messageId}_${Date.now()}.json`);

    fs.writeFileSync(responseFile, JSON.stringify(responseData, null, 2));

    log('INFO', `✓ Response ready [${conv.channel}] ${conv.sender} (${finalResponse.length} chars)`);
    emitEvent('response_ready', { channel: conv.channel, sender: conv.sender, responseLength: finalResponse.length, responseText: finalResponse, messageId: conv.messageId });

    // Clean up
    conversations.delete(conv.id);
}

// Process a single message
async function processMessage(messageFile: string): Promise<void> {
    const processingFile = path.join(QUEUE_PROCESSING, path.basename(messageFile));

    try {
        // Move to processing to mark as in-progress
        fs.renameSync(messageFile, processingFile);

        // Read message
        const messageData: MessageData = safeParseJSON(fs.readFileSync(processingFile, 'utf8'), path.basename(processingFile));
        const { channel, sender, message: rawMessage, timestamp, messageId } = messageData;
        const isInternal = !!messageData.conversationId;

        log('INFO', `Processing [${isInternal ? 'internal' : channel}] ${isInternal ? `@${messageData.fromAgent}→@${messageData.agent}` : `from ${sender}`}: ${rawMessage.substring(0, 50)}...`);
        if (!isInternal) {
            emitEvent('message_received', { channel, sender, message: rawMessage.substring(0, 120), messageId });
        }

        // Get settings, agents, and teams
        const settings = getSettings();
        const agents = getAgents(settings);
        const teams = getTeams(settings);

        // Get workspace path from settings
        const workspacePath = settings?.workspace?.path || path.join(require('os').homedir(), 'tinyclaw-workspace');

        // Route message to agent (or team)
        let agentId: string;
        let message: string;
        let isTeamRouted = false;

        if (messageData.agent && agents[messageData.agent]) {
            // Pre-routed (by channel client or internal message)
            agentId = messageData.agent;
            message = rawMessage;
        } else {
            // Parse @agent or @team prefix
            const routing = parseAgentRouting(rawMessage, agents, teams);
            agentId = routing.agentId;
            message = routing.message;
            isTeamRouted = !!routing.isTeam;
        }

        // Easter egg: Handle multiple agent mentions (only for external messages)
        if (!isInternal && agentId === 'error') {
            log('INFO', `Multiple agents detected, sending easter egg message`);

            const responseFile = path.join(QUEUE_OUTGOING, path.basename(processingFile));
            const responseData: ResponseData = {
                channel,
                sender,
                message: message,
                originalMessage: rawMessage,
                timestamp: Date.now(),
                messageId,
            };

            fs.writeFileSync(responseFile, JSON.stringify(responseData, null, 2));
            fs.unlinkSync(processingFile);
            log('INFO', `✓ Easter egg sent to ${sender}`);
            return;
        }

        // Fall back to default if agent not found
        if (!agents[agentId]) {
            agentId = 'default';
            message = rawMessage;
        }

        // Final fallback: use first available agent if no default
        if (!agents[agentId]) {
            agentId = Object.keys(agents)[0];
        }

        const agent = agents[agentId];
        log('INFO', `Routing to agent: ${agent.name} (${agentId}) [${agent.provider}/${agent.model}]`);
        if (!isInternal) {
            emitEvent('agent_routed', { agentId, agentName: agent.name, provider: agent.provider, model: agent.model, isTeamRouted });
        }

        // Determine team context
        let teamContext: { teamId: string; team: TeamConfig } | null = null;
        if (isInternal) {
            // Internal messages inherit team context from their conversation
            const conv = conversations.get(messageData.conversationId!);
            if (conv) teamContext = conv.teamContext;
        } else {
            if (isTeamRouted) {
                for (const [tid, t] of Object.entries(teams)) {
                    if (t.leader_agent === agentId && t.agents.includes(agentId)) {
                        teamContext = { teamId: tid, team: t };
                        break;
                    }
                }
            }
            if (!teamContext) {
                teamContext = findTeamForAgent(agentId, teams);
            }
        }

        // Check for per-agent reset
        const agentResetFlag = getAgentResetFlag(agentId, workspacePath);
        const shouldReset = fs.existsSync(agentResetFlag);

        if (shouldReset) {
            fs.unlinkSync(agentResetFlag);
        }

        // For internal messages: append pending response indicator so the agent
        // knows other teammates are still processing and won't re-mention them.
        if (isInternal && messageData.conversationId) {
            const conv = conversations.get(messageData.conversationId);
            if (conv) {
                // pending includes this message (not yet decremented), so subtract 1 for "others"
                const othersPending = conv.pending - 1;
                if (othersPending > 0) {
                    message += `\n\n------\n\n[${othersPending} other teammate response(s) are still being processed and will be delivered when ready. Do not re-mention teammates who haven't responded yet.]`;
                }
            }
        }

        // Invoke agent
        emitEvent('chain_step_start', { agentId, agentName: agent.name, fromAgent: messageData.fromAgent || null });
        let response: string;
        try {
            response = await invokeAgent(agent, agentId, message, workspacePath, shouldReset, agents, teams);
        } catch (error) {
            const provider = agent.provider || 'anthropic';
            const providerLabel = provider === 'openai' ? 'Codex' : provider === 'opencode' ? 'OpenCode' : 'Claude';
            log('ERROR', `${providerLabel} error (agent: ${agentId}): ${(error as Error).message}`);
            response = "Sorry, I encountered an error processing your request. Please check the queue logs.";
        }

        emitEvent('chain_step_done', { agentId, agentName: agent.name, responseLength: response.length, responseText: response });

        // --- No team context: simple response to user ---
        if (!teamContext) {
            let finalResponse = response.trim();

            // Detect files
            const outboundFilesSet = new Set<string>();
            collectFiles(finalResponse, outboundFilesSet);
            const outboundFiles = Array.from(outboundFilesSet);
            if (outboundFiles.length > 0) {
                finalResponse = finalResponse.replace(/\[send_file:\s*[^\]]+\]/g, '').trim();
            }

            // Handle long responses — send as file attachment
            const { message: responseMessage, files: allFiles } = handleLongResponse(finalResponse, outboundFiles);

            const responseData: ResponseData = {
                channel,
                sender,
                message: responseMessage,
                originalMessage: rawMessage,
                timestamp: Date.now(),
                messageId,
                agent: agentId,
                files: allFiles.length > 0 ? allFiles : undefined,
            };

            const responseFile = channel === 'heartbeat'
                ? path.join(QUEUE_OUTGOING, `${messageId}.json`)
                : path.join(QUEUE_OUTGOING, `${channel}_${messageId}_${Date.now()}.json`);

            fs.writeFileSync(responseFile, JSON.stringify(responseData, null, 2));

            log('INFO', `✓ Response ready [${channel}] ${sender} via agent:${agentId} (${finalResponse.length} chars)`);
            emitEvent('response_ready', { channel, sender, agentId, responseLength: finalResponse.length, responseText: finalResponse, messageId });

            fs.unlinkSync(processingFile);
            return;
        }

        // --- Team context: conversation-based message passing ---

        // Get or create conversation
        let conv: Conversation;
        if (isInternal && messageData.conversationId && conversations.has(messageData.conversationId)) {
            conv = conversations.get(messageData.conversationId)!;
        } else {
            // New conversation
            const convId = `${messageId}_${Date.now()}`;
            conv = {
                id: convId,
                channel,
                sender,
                originalMessage: rawMessage,
                messageId,
                pending: 1, // this initial message
                responses: [],
                files: new Set(),
                totalMessages: 0,
                maxMessages: MAX_CONVERSATION_MESSAGES,
                teamContext,
                startTime: Date.now(),
                outgoingMentions: new Map(),
            };
            conversations.set(convId, conv);
            log('INFO', `Conversation started: ${convId} (team: ${teamContext.team.name})`);
            emitEvent('team_chain_start', { teamId: teamContext.teamId, teamName: teamContext.team.name, agents: teamContext.team.agents, leader: teamContext.team.leader_agent });
        }

        // Record this agent's response
        conv.responses.push({ agentId, response });
        conv.totalMessages++;
        collectFiles(response, conv.files);

        // Check for teammate mentions
        const teammateMentions = extractTeammateMentions(
            response, agentId, conv.teamContext.teamId, teams, agents
        );

        if (teammateMentions.length > 0 && conv.totalMessages < conv.maxMessages) {
            // Enqueue internal messages for each mention
            conv.pending += teammateMentions.length;
            conv.outgoingMentions.set(agentId, teammateMentions.length);
            for (const mention of teammateMentions) {
                log('INFO', `@${agentId} → @${mention.teammateId}`);
                emitEvent('chain_handoff', { teamId: conv.teamContext.teamId, fromAgent: agentId, toAgent: mention.teammateId });

                const internalMsg = `[Message from teammate @${agentId}]:\n${mention.message}`;
                enqueueInternalMessage(conv.id, agentId, mention.teammateId, internalMsg, messageData);
            }
        } else if (teammateMentions.length > 0) {
            log('WARN', `Conversation ${conv.id} hit max messages (${conv.maxMessages}) — not enqueuing further mentions`);
        }

        // This branch is done
        conv.pending--;

        if (conv.pending === 0) {
            completeConversation(conv);
        } else {
            log('INFO', `Conversation ${conv.id}: ${conv.pending} branch(es) still pending`);
        }

        // Clean up processing file
        fs.unlinkSync(processingFile);

    } catch (error) {
        log('ERROR', `Processing error: ${(error as Error).message}`);

        // Move back to incoming for retry
        if (fs.existsSync(processingFile)) {
            try {
                fs.renameSync(processingFile, messageFile);
            } catch (e) {
                log('ERROR', `Failed to move file back: ${(e as Error).message}`);
            }
        }
    }
}

// Per-agent processing chains - ensures messages to same agent are sequential
const agentProcessingChains = new Map<string, Promise<void>>();

/**
 * Peek at a message file to determine which agent it's routed to.
 * Also resolves team IDs to their leader agent.
 */
function peekAgentId(filePath: string): string {
    try {
        const messageData = safeParseJSON<MessageData>(fs.readFileSync(filePath, 'utf8'));
        const settings = getSettings();
        const agents = getAgents(settings);
        const teams = getTeams(settings);

        // Check for pre-routed agent
        if (messageData.agent && agents[messageData.agent]) {
            return messageData.agent;
        }

        // Parse @agent_id or @team_id prefix
        const routing = parseAgentRouting(messageData.message || '', agents, teams);
        return routing.agentId || 'default';
    } catch {
        return 'default';
    }
}

// Main processing loop
async function processQueue(): Promise<void> {
    try {
        // Get all files from incoming queue, sorted by timestamp
        const files: QueueFile[] = fs.readdirSync(QUEUE_INCOMING)
            .filter(f => f.endsWith('.json'))
            .map(f => ({
                name: f,
                path: path.join(QUEUE_INCOMING, f),
                time: fs.statSync(path.join(QUEUE_INCOMING, f)).mtimeMs
            }))
            .sort((a, b) => a.time - b.time);

        if (files.length > 0) {
            log('DEBUG', `Found ${files.length} message(s) in queue`);

            // Process messages in parallel by agent (sequential within each agent)
            for (const file of files) {
                // Skip files already queued in a promise chain
                if (queuedFiles.has(file.name)) continue;
                queuedFiles.add(file.name);

                // Determine target agent
                const agentId = peekAgentId(file.path);

                // Get or create promise chain for this agent
                const currentChain = agentProcessingChains.get(agentId) || Promise.resolve();

                // Chain this message to the agent's promise
                const newChain = currentChain
                    .then(() => processMessage(file.path))
                    .catch(error => {
                        log('ERROR', `Error processing message for agent ${agentId}: ${error.message}`);
                    })
                    .finally(() => {
                        queuedFiles.delete(file.name);
                    });

                // Update the chain
                agentProcessingChains.set(agentId, newChain);

                // Clean up completed chains to avoid memory leaks
                newChain.finally(() => {
                    if (agentProcessingChains.get(agentId) === newChain) {
                        agentProcessingChains.delete(agentId);
                    }
                });
            }
        }
    } catch (error) {
        log('ERROR', `Queue processing error: ${(error as Error).message}`);
    }
}

// Log agent and team configuration on startup
function logAgentConfig(): void {
    const settings = getSettings();
    const agents = getAgents(settings);
    const teams = getTeams(settings);

    const agentCount = Object.keys(agents).length;
    log('INFO', `Loaded ${agentCount} agent(s):`);
    for (const [id, agent] of Object.entries(agents)) {
        log('INFO', `  ${id}: ${agent.name} [${agent.provider}/${agent.model}] cwd=${agent.working_directory}`);
    }

    const teamCount = Object.keys(teams).length;
    if (teamCount > 0) {
        log('INFO', `Loaded ${teamCount} team(s):`);
        for (const [id, team] of Object.entries(teams)) {
            log('INFO', `  ${id}: ${team.name} [agents: ${team.agents.join(', ')}] leader=${team.leader_agent}`);
        }
    }
}

// Ensure events dir exists
if (!fs.existsSync(EVENTS_DIR)) {
    fs.mkdirSync(EVENTS_DIR, { recursive: true });
}

// ─── HTTP API Server ────────────────────────────────────────────────────────

const API_PORT = parseInt(process.env.TINYCLAW_API_PORT || '3001', 10);

/** Collect SSE clients for real-time event streaming. */
const sseClients = new Set<http.ServerResponse>();

/** Read the full body of an incoming request. */
function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks).toString()));
        req.on('error', reject);
    });
}

/** Send a JSON response. */
function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end(payload);
}

/** Broadcast an event to all SSE clients. */
function broadcastSSE(event: string, data: unknown): void {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
        try { client.write(message); } catch { sseClients.delete(client); }
    }
}

/** Wrap emitEvent to also broadcast via SSE. */
const _originalEmitEvent = emitEvent;
function emitEventWithSSE(type: string, data: Record<string, unknown>): void {
    _originalEmitEvent(type, data);
    broadcastSSE(type, { type, timestamp: Date.now(), ...data });
}

// Patch the emitEvent calls — override the imported binding
// We'll use a module-level wrapper instead
const emitEventSSE = emitEventWithSSE;

const apiServer = http.createServer(async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
        return;
    }

    const url = new URL(req.url || '/', `http://localhost:${API_PORT}`);
    const pathname = url.pathname;

    try {
        // ── POST /api/message — Enqueue a new message ───────────────────
        if (req.method === 'POST' && pathname === '/api/message') {
            const body = JSON.parse(await readBody(req));
            const { message, agent, sender, channel } = body as {
                message?: string; agent?: string; sender?: string; channel?: string;
            };

            if (!message || typeof message !== 'string') {
                return jsonResponse(res, 400, { error: 'message is required' });
            }

            const messageData: MessageData = {
                channel: channel || 'mission-control',
                sender: sender || 'Mission Control',
                message,
                timestamp: Date.now(),
                messageId: `mc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                agent: agent || undefined,
            };

            const filename = `mc_${messageData.messageId}.json`;
            fs.writeFileSync(path.join(QUEUE_INCOMING, filename), JSON.stringify(messageData, null, 2));

            log('INFO', `[API] Message enqueued: ${message.substring(0, 60)}...`);
            broadcastSSE('message_enqueued', { messageId: messageData.messageId, agent, message: message.substring(0, 120) });

            return jsonResponse(res, 200, { ok: true, messageId: messageData.messageId });
        }

        // ── GET /api/agents — List all agents ───────────────────────────
        if (req.method === 'GET' && pathname === '/api/agents') {
            const settings = getSettings();
            const agents = getAgents(settings);
            return jsonResponse(res, 200, agents);
        }

        // ── GET /api/teams — List all teams ─────────────────────────────
        if (req.method === 'GET' && pathname === '/api/teams') {
            const settings = getSettings();
            const teams = getTeams(settings);
            return jsonResponse(res, 200, teams);
        }

        // ── GET /api/settings — Get current settings ────────────────────
        if (req.method === 'GET' && pathname === '/api/settings') {
            const settings = getSettings();
            return jsonResponse(res, 200, settings);
        }

        // ── PUT /api/settings — Update settings ─────────────────────────
        if (req.method === 'PUT' && pathname === '/api/settings') {
            const body = JSON.parse(await readBody(req));
            // Merge with existing settings
            const current = getSettings();
            const merged = { ...current, ...body } as Settings;
            fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2) + '\n');
            log('INFO', '[API] Settings updated');
            return jsonResponse(res, 200, { ok: true, settings: merged });
        }

        // ── GET /api/queue/status — Queue status ────────────────────────
        if (req.method === 'GET' && pathname === '/api/queue/status') {
            const incoming = fs.readdirSync(QUEUE_INCOMING).filter(f => f.endsWith('.json')).length;
            const processing = fs.readdirSync(QUEUE_PROCESSING).filter(f => f.endsWith('.json')).length;
            const outgoing = fs.readdirSync(QUEUE_OUTGOING).filter(f => f.endsWith('.json')).length;
            const activeConversations = conversations.size;
            return jsonResponse(res, 200, { incoming, processing, outgoing, activeConversations });
        }

        // ── GET /api/responses — Recent outgoing responses ──────────────
        if (req.method === 'GET' && pathname === '/api/responses') {
            const limit = parseInt(url.searchParams.get('limit') || '20', 10);
            const files = fs.readdirSync(QUEUE_OUTGOING)
                .filter(f => f.endsWith('.json'))
                .map(f => ({ name: f, time: fs.statSync(path.join(QUEUE_OUTGOING, f)).mtimeMs }))
                .sort((a, b) => b.time - a.time)
                .slice(0, limit);

            const responses: ResponseData[] = [];
            for (const file of files) {
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(QUEUE_OUTGOING, file.name), 'utf8'));
                    responses.push(data);
                } catch { /* skip bad files */ }
            }
            return jsonResponse(res, 200, responses);
        }

        // ── GET /api/events/stream — Server-Sent Events ─────────────────
        if (req.method === 'GET' && pathname === '/api/events/stream') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*',
            });
            res.write(`event: connected\ndata: ${JSON.stringify({ timestamp: Date.now() })}\n\n`);
            sseClients.add(res);
            req.on('close', () => sseClients.delete(res));
            return; // keep connection open
        }

        // ── GET /api/events — Recent events (polling) ───────────────────
        if (req.method === 'GET' && pathname === '/api/events') {
            const since = parseInt(url.searchParams.get('since') || '0', 10);
            const limit = parseInt(url.searchParams.get('limit') || '50', 10);

            const eventFiles = fs.readdirSync(EVENTS_DIR)
                .filter(f => f.endsWith('.json'))
                .map(f => {
                    const ts = parseInt(f.split('-')[0], 10);
                    return { name: f, ts };
                })
                .filter(f => f.ts > since)
                .sort((a, b) => b.ts - a.ts)
                .slice(0, limit);

            const events: unknown[] = [];
            for (const file of eventFiles) {
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(EVENTS_DIR, file.name), 'utf8'));
                    events.push(data);
                } catch { /* skip */ }
            }
            return jsonResponse(res, 200, events);
        }

        // ── GET /api/logs — Recent log lines ────────────────────────────
        if (req.method === 'GET' && pathname === '/api/logs') {
            const limit = parseInt(url.searchParams.get('limit') || '100', 10);
            try {
                const logContent = fs.readFileSync(LOG_FILE, 'utf8');
                const lines = logContent.trim().split('\n').slice(-limit);
                return jsonResponse(res, 200, { lines });
            } catch {
                return jsonResponse(res, 200, { lines: [] });
            }
        }

        // ── GET /api/chats — List chat histories ────────────────────────
        if (req.method === 'GET' && pathname === '/api/chats') {
            const chats: { teamId: string; file: string; time: number }[] = [];
            if (fs.existsSync(CHATS_DIR)) {
                for (const teamDir of fs.readdirSync(CHATS_DIR)) {
                    const teamPath = path.join(CHATS_DIR, teamDir);
                    if (fs.statSync(teamPath).isDirectory()) {
                        for (const file of fs.readdirSync(teamPath).filter(f => f.endsWith('.md'))) {
                            const time = fs.statSync(path.join(teamPath, file)).mtimeMs;
                            chats.push({ teamId: teamDir, file, time });
                        }
                    }
                }
            }
            chats.sort((a, b) => b.time - a.time);
            return jsonResponse(res, 200, chats);
        }

        // ── 404 ─────────────────────────────────────────────────────────
        jsonResponse(res, 404, { error: 'Not found' });

    } catch (error) {
        log('ERROR', `[API] ${(error as Error).message}`);
        jsonResponse(res, 500, { error: 'Internal server error' });
    }
});

apiServer.listen(API_PORT, () => {
    log('INFO', `API server listening on http://localhost:${API_PORT}`);
});

// ─── Main loop ──────────────────────────────────────────────────────────────

log('INFO', 'Queue processor started');
recoverOrphanedFiles();
log('INFO', `Watching: ${QUEUE_INCOMING}`);
logAgentConfig();
emitEvent('processor_start', { agents: Object.keys(getAgents(getSettings())), teams: Object.keys(getTeams(getSettings())) });

// Process queue every 1 second
setInterval(processQueue, 1000);

// Graceful shutdown
process.on('SIGINT', () => {
    log('INFO', 'Shutting down queue processor...');
    apiServer.close();
    process.exit(0);
});

process.on('SIGTERM', () => {
    log('INFO', 'Shutting down queue processor...');
    apiServer.close();
    process.exit(0);
});
