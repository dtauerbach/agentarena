"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Props = {
  runId: string;
  agentNames: string[];
  rooms: string[];
  muted: Record<string, boolean>;
};

// G3: the operator is the moderator. Everything sent from here is applied by
// the engine at the current simulated time and logged as an event.
export function ModeratorBox({ runId, agentNames, rooms, muted }: Props) {
  const [target, setTarget] = useState("all");
  const [text, setText] = useState("");
  const [roomAgent, setRoomAgent] = useState(agentNames[0] ?? "");
  const [room, setRoom] = useState(rooms[0] ?? "main");
  const [status, setStatus] = useState<string | null>(null);

  const send = async (command: Record<string, unknown>) => {
    setStatus(null);
    const response = await fetch(`/api/runs/${runId}/operator`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
    });
    setStatus(response.ok ? "sent" : "failed");
  };

  const selectClass = "h-8 rounded-md border bg-transparent px-2 text-xs";
  return (
    <div className="space-y-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
        Moderator — actions apply now and are logged
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="inject target"
          className={selectClass}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        >
          <option value="all">all agents</option>
          {agentNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <Input
          className="h-8 w-64 text-xs"
          placeholder="private injection text…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={text.trim() === ""}
          onClick={() => {
            void send({ kind: "inject", agent: target, text: text.trim() });
            setText("");
          }}
        >
          Inject
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="room agent"
          className={selectClass}
          value={roomAgent}
          onChange={(e) => setRoomAgent(e.target.value)}
        >
          {agentNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            send({
              kind: muted[roomAgent] ? "unmute" : "mute",
              agent: roomAgent,
            })
          }
        >
          {muted[roomAgent] ? "Unmute" : "Mute"}
        </Button>
        <select
          aria-label="room"
          className={selectClass}
          value={room}
          onChange={(e) => setRoom(e.target.value)}
        >
          {rooms.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="outline"
          onClick={() => send({ kind: "join", agent: roomAgent, room })}
        >
          Join
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => send({ kind: "leave", agent: roomAgent, room })}
        >
          Leave
        </Button>
        {status && (
          <span className="text-xs text-muted-foreground">{status}</span>
        )}
      </div>
    </div>
  );
}
