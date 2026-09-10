"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Props = { experiment: string; file: string; initial: string };

export function YamlEditor({ experiment, file, initial }: Props) {
  const router = useRouter();
  const [content, setContent] = useState(initial);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newFile, setNewFile] = useState("");

  const save = async () => {
    setMessage(null);
    setError(null);
    const response = await fetch("/api/experiments/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ experiment, file, content }),
    });
    const body = (await response.json()) as { error?: string };
    if (!response.ok) {
      setError(body.error ?? "save failed");
      return;
    }
    setDirty(false);
    setMessage("saved");
    router.refresh();
  };

  const duplicate = async () => {
    setMessage(null);
    setError(null);
    const target = newFile.endsWith(".yaml") ? newFile : `${newFile}.yaml`;
    const response = await fetch("/api/experiments/duplicate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ experiment, file, newFile: target }),
    });
    const body = (await response.json()) as { error?: string };
    if (!response.ok) {
      setError(body.error ?? "duplicate failed");
      return;
    }
    router.push(`/experiments/${experiment}/${target}`);
  };

  return (
    <div className="space-y-2">
      <textarea
        className="h-96 w-full resize-y rounded-lg border-2 border-input bg-background p-4 font-mono text-xs leading-relaxed focus-visible:border-ring focus-visible:outline-none"
        value={content}
        spellCheck={false}
        onChange={(e) => {
          setContent(e.target.value);
          setDirty(true);
          setMessage(null);
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={save} disabled={!dirty}>
          Save
        </Button>
        {message && (
          <span className="text-sm text-muted-foreground">{message}</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Input
            className="w-56"
            placeholder="new-file.yaml"
            value={newFile}
            onChange={(e) => setNewFile(e.target.value)}
          />
          <Button
            variant="outline"
            onClick={duplicate}
            disabled={newFile.trim() === ""}
          >
            Duplicate
          </Button>
        </div>
      </div>
      {error && (
        <pre className="whitespace-pre-wrap rounded-md border border-destructive/50 bg-destructive/5 p-3 text-xs text-destructive">
          {error}
        </pre>
      )}
    </div>
  );
}
