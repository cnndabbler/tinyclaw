"use client";

import { usePolling } from "@/lib/hooks";
import { getAgents, type AgentConfig } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Bot, Cpu, FolderOpen, FileText } from "lucide-react";

export default function AgentsPage() {
  const { data: agents, loading } = usePolling<Record<string, AgentConfig>>(getAgents, 5000);

  return (
    <div className="p-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Bot className="h-5 w-5 text-primary" />
          Agents
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage and monitor your AI agents
        </p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="h-3 w-3 animate-spin border-2 border-primary border-t-transparent" />
          Loading agents...
        </div>
      ) : agents && Object.keys(agents).length > 0 ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Object.entries(agents).map(([id, agent]) => (
            <AgentCard key={id} id={id} agent={agent} />
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="p-12 text-center">
            <Bot className="h-10 w-10 text-muted-foreground mx-auto mb-4" />
            <p className="text-lg font-medium">No agents configured</p>
            <p className="text-sm text-muted-foreground mt-1">
              Add agents in your settings.json file to get started
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function AgentCard({ id, agent }: { id: string; agent: AgentConfig }) {
  const providerColors: Record<string, string> = {
    anthropic: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
    openai: "bg-green-500/10 text-green-600 dark:text-green-400",
    opencode: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  };

  return (
    <Card className="transition-colors hover:border-primary/50">
      <CardHeader>
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center bg-primary/10 text-primary text-sm font-bold uppercase">
              {agent.name.slice(0, 2)}
            </div>
            <div>
              <CardTitle className="text-base">{agent.name}</CardTitle>
              <CardDescription>@{id}</CardDescription>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <Cpu className="h-3.5 w-3.5 text-muted-foreground" />
          <Badge className={providerColors[agent.provider] || "bg-secondary text-secondary-foreground"}>
            {agent.provider}
          </Badge>
          <Badge variant="outline">{agent.model}</Badge>
        </div>

        <div className="flex items-start gap-2">
          <FolderOpen className="h-3.5 w-3.5 text-muted-foreground mt-0.5" />
          <p className="text-xs text-muted-foreground font-mono break-all">
            {agent.working_directory}
          </p>
        </div>

        {agent.system_prompt && (
          <div className="flex items-start gap-2">
            <FileText className="h-3.5 w-3.5 text-muted-foreground mt-0.5" />
            <p className="text-xs text-muted-foreground line-clamp-2">
              {agent.system_prompt}
            </p>
          </div>
        )}

        {agent.prompt_file && (
          <div className="flex items-start gap-2">
            <FileText className="h-3.5 w-3.5 text-muted-foreground mt-0.5" />
            <p className="text-xs text-muted-foreground font-mono">
              {agent.prompt_file}
            </p>
          </div>
        )}

        <div className="pt-2 border-t">
          <p className="text-xs text-muted-foreground">
            Send messages with <code className="bg-muted px-1 py-0.5 font-mono">@{id}</code> prefix
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
