"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { usePolling, timeAgo } from "@/lib/hooks";
import {
  getAgents,
  getTeams,
  sendMessage,
  subscribeToEvents,
  type AgentConfig,
  type TeamConfig,
  type EventData,
} from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  Terminal,
  Send,
  Bot,
  Users,
  Loader2,
  CheckCircle2,
  AlertCircle,
  ArrowRight,
  Radio,
} from "lucide-react";

interface FeedItem {
  id: string;
  type: "sent" | "event";
  timestamp: number;
  data: Record<string, unknown>;
}

export default function ConsolePage() {
  const { data: agents } = usePolling<Record<string, AgentConfig>>(getAgents, 5000);
  const { data: teams } = usePolling<Record<string, TeamConfig>>(getTeams, 5000);

  const [message, setMessage] = useState("");
  const [target, setTarget] = useState("");
  const [sending, setSending] = useState(false);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [connected, setConnected] = useState(false);
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsub = subscribeToEvents(
      (event: EventData) => {
        setConnected(true);
        setFeed((prev) => [
          {
            id: `${event.timestamp}-${Math.random().toString(36).slice(2, 6)}`,
            type: "event" as const,
            timestamp: event.timestamp,
            data: event as unknown as Record<string, unknown>,
          },
          ...prev,
        ].slice(0, 200));
      },
      () => setConnected(false)
    );
    return unsub;
  }, []);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [feed.length]);

  const handleSend = useCallback(async () => {
    if (!message.trim() || sending) return;

    const finalMessage = target ? `${target} ${message}` : message;
    setSending(true);

    try {
      const result = await sendMessage({
        message: finalMessage,
        sender: "Web",
        channel: "web",
      });

      setFeed((prev) => [
        {
          id: result.messageId,
          type: "sent" as const,
          timestamp: Date.now(),
          data: { message: finalMessage, messageId: result.messageId, target },
        },
        ...prev,
      ]);

      setMessage("");
    } catch (err) {
      setFeed((prev) => [
        {
          id: `err-${Date.now()}`,
          type: "event" as const,
          timestamp: Date.now(),
          data: { type: "error", message: (err as Error).message },
        },
        ...prev,
      ]);
    } finally {
      setSending(false);
    }
  }, [message, target, sending]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSend();
    }
  };

  const targetOptions: { value: string; label: string; type: string }[] = [
    { value: "", label: "Default Agent", type: "default" },
  ];
  if (agents) {
    for (const [id, agent] of Object.entries(agents)) {
      targetOptions.push({ value: `@${id}`, label: `${agent.name} (@${id})`, type: "agent" });
    }
  }
  if (teams) {
    for (const [id, team] of Object.entries(teams)) {
      targetOptions.push({ value: `@${id}`, label: `${team.name} (@${id})`, type: "team" });
    }
  }

  return (
    <div className="flex h-full flex-col p-8 gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Terminal className="h-5 w-5 text-primary" />
            Console
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Send messages to agents and teams
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className={`h-2 w-2 ${connected ? "bg-primary animate-pulse-dot" : "bg-destructive"}`} />
          <span className="text-xs text-muted-foreground">
            {connected ? "Connected" : "Disconnected"}
          </span>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">New Message</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <label className="text-sm font-medium text-muted-foreground whitespace-nowrap">
              Send to:
            </label>
            <Select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="max-w-xs"
            >
              {targetOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.type === "team" ? "Team: " : opt.type === "agent" ? "Agent: " : ""}
                  {opt.label}
                </option>
              ))}
            </Select>
            {target && (
              <Badge variant="outline" className="shrink-0">
                {target}
              </Badge>
            )}
          </div>

          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type your message... (Ctrl+Enter to send)"
            rows={4}
            className="font-mono text-sm"
          />

          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              Ctrl+Enter to send
            </span>
            <Button onClick={handleSend} disabled={!message.trim() || sending}>
              {sending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              Send Message
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="flex-1 min-h-0">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Radio className="h-3.5 w-3.5 text-primary" />
            Live Feed
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div ref={feedRef} className="space-y-2 max-h-[calc(100vh-560px)] overflow-y-auto">
            {feed.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">
                Send a message or wait for events...
              </p>
            ) : (
              feed.map((item) => (
                <FeedEntry key={item.id} item={item} />
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function FeedEntry({ item }: { item: FeedItem }) {
  const d = item.data;

  if (item.type === "sent") {
    const target = d.target ? String(d.target) : "";
    return (
      <div className="flex items-start gap-3 border-b border-border/50 pb-2 animate-slide-up">
        <Send className="h-3.5 w-3.5 mt-1 text-primary shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-primary">SENT</span>
            {target && (
              <Badge variant="outline" className="text-[10px]">
                {target}
              </Badge>
            )}
          </div>
          <p className="text-sm text-foreground mt-0.5 break-words whitespace-pre-wrap">
            {String(d.message ?? "")}
          </p>
        </div>
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {timeAgo(item.timestamp)}
        </span>
      </div>
    );
  }

  const eventType = String(d.type || "unknown");

  const icon = (() => {
    switch (eventType) {
      case "response_ready":
        return <CheckCircle2 className="h-3.5 w-3.5 mt-1 text-emerald-500 shrink-0" />;
      case "error":
        return <AlertCircle className="h-3.5 w-3.5 mt-1 text-destructive shrink-0" />;
      case "agent_routed":
        return <Bot className="h-3.5 w-3.5 mt-1 text-primary shrink-0" />;
      case "chain_handoff":
        return <ArrowRight className="h-3.5 w-3.5 mt-1 text-orange-500 shrink-0" />;
      case "team_chain_start":
      case "team_chain_end":
        return <Users className="h-3.5 w-3.5 mt-1 text-purple-500 shrink-0" />;
      default:
        return <div className="h-3.5 w-3.5 mt-1 bg-muted-foreground/40 shrink-0" />;
    }
  })();

  return (
    <div className="flex items-start gap-3 border-b border-border/50 pb-2 animate-slide-up">
      {icon}
      <div className="flex-1 min-w-0">
        <span className="text-xs font-semibold uppercase text-muted-foreground">
          {eventType.replace(/_/g, " ")}
        </span>
        {d.responseText ? (
          <p className="text-sm text-foreground mt-0.5 break-words whitespace-pre-wrap line-clamp-4">
            {String(d.responseText).substring(0, 500)}
          </p>
        ) : d.message ? (
          <p className="text-sm text-muted-foreground mt-0.5 break-words truncate">
            {String(d.message)}
          </p>
        ) : null}
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          {d.agentId ? <Badge variant="secondary" className="text-[10px]">@{String(d.agentId)}</Badge> : null}
          {d.channel ? <Badge variant="outline" className="text-[10px]">{String(d.channel)}</Badge> : null}
          {d.sender ? (
            <span className="text-[10px] text-muted-foreground">from {String(d.sender)}</span>
          ) : null}
        </div>
      </div>
      <span className="text-xs text-muted-foreground whitespace-nowrap">
        {timeAgo(item.timestamp)}
      </span>
    </div>
  );
}
