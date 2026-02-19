"use client";

import { usePolling } from "@/lib/hooks";
import { getAgents, getTeams, type AgentConfig, type TeamConfig } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Users, Crown, Bot, ArrowRight } from "lucide-react";

export default function TeamsPage() {
  const { data: agents } = usePolling<Record<string, AgentConfig>>(getAgents, 5000);
  const { data: teams, loading } = usePolling<Record<string, TeamConfig>>(getTeams, 5000);

  return (
    <div className="p-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Users className="h-5 w-5 text-primary" />
          Teams
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Agent teams for collaborative task execution
        </p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="h-3 w-3 animate-spin border-2 border-primary border-t-transparent" />
          Loading teams...
        </div>
      ) : teams && Object.keys(teams).length > 0 ? (
        <div className="space-y-6">
          {Object.entries(teams).map(([id, team]) => (
            <TeamCard key={id} id={id} team={team} agents={agents || {}} />
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="p-12 text-center">
            <Users className="h-10 w-10 text-muted-foreground mx-auto mb-4" />
            <p className="text-lg font-medium">No teams configured</p>
            <p className="text-sm text-muted-foreground mt-1">
              Define teams in your settings.json to enable multi-agent collaboration
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">How Team Collaboration Works</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-3">
          <div className="flex items-start gap-3">
            <div className="flex h-6 w-6 items-center justify-center bg-primary/10 text-primary text-xs font-bold shrink-0">1</div>
            <p>Messages sent to <code className="bg-muted px-1 py-0.5 font-mono">@team_id</code> are routed to the team leader agent.</p>
          </div>
          <div className="flex items-start gap-3">
            <div className="flex h-6 w-6 items-center justify-center bg-primary/10 text-primary text-xs font-bold shrink-0">2</div>
            <p>The leader can delegate to teammates using <code className="bg-muted px-1 py-0.5 font-mono">[@teammate: message]</code> tags.</p>
          </div>
          <div className="flex items-start gap-3">
            <div className="flex h-6 w-6 items-center justify-center bg-primary/10 text-primary text-xs font-bold shrink-0">3</div>
            <p>Teammates process in parallel and can mention each other for further collaboration.</p>
          </div>
          <div className="flex items-start gap-3">
            <div className="flex h-6 w-6 items-center justify-center bg-primary/10 text-primary text-xs font-bold shrink-0">4</div>
            <p>When all branches resolve, responses are aggregated and sent back.</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function TeamCard({
  id,
  team,
  agents,
}: {
  id: string;
  team: TeamConfig;
  agents: Record<string, AgentConfig>;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-lg">{team.name}</CardTitle>
            <CardDescription>@{id}</CardDescription>
          </div>
          <Badge variant="outline">
            {team.agents.length} agent{team.agents.length !== 1 ? "s" : ""}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2 flex-wrap">
          {team.agents.map((agentId, i) => {
            const agent = agents[agentId];
            const isLeader = agentId === team.leader_agent;
            return (
              <div key={agentId} className="flex items-center gap-2">
                {i > 0 && <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />}
                <div
                  className={`flex items-center gap-2 border px-3 py-2 ${
                    isLeader ? "border-primary bg-primary/5" : ""
                  }`}
                >
                  <Bot className={`h-3.5 w-3.5 ${isLeader ? "text-primary" : "text-muted-foreground"}`} />
                  <div>
                    <p className="text-sm font-medium flex items-center gap-1.5">
                      {agent?.name || agentId}
                      {isLeader && (
                        <Crown className="h-3 w-3 text-primary" />
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      @{agentId}
                      {agent && ` / ${agent.provider} / ${agent.model}`}
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-4 pt-4 border-t">
          <p className="text-xs text-muted-foreground">
            Send messages with <code className="bg-muted px-1 py-0.5 font-mono">@{id}</code> prefix to start team collaboration
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
