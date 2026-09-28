"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Props = { templates: { id: string; blurb: string }[] };

export function CreateGameForm({ templates }: Props) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [template, setTemplate] = useState(templates[0]?.id ?? "blank");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/experiments/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, template }),
      });
      const body = (await response.json()) as {
        experiment?: string;
        file?: string;
        error?: string;
      };
      if (!response.ok || !body.experiment)
        throw new Error(body.error ?? "create failed");
      router.push(`/experiments/${body.experiment}/${body.file}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <label
        htmlFor="create-name"
        className="flex flex-col gap-1 text-sm font-medium"
      >
        Name your game
        <Input
          id="create-name"
          className="max-w-sm"
          placeholder="e.g. werewolf, auction-house, silent-court"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <span className="text-xs font-normal text-muted-foreground">
          lowercase letters, digits, dashes — becomes the folder
          experiments/&lt;name&gt;/
        </span>
      </label>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Start from</legend>
        {templates.map((t) => (
          <label
            key={t.id}
            className="flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm has-[:checked]:border-ring has-[:checked]:bg-muted/40"
          >
            <input
              type="radio"
              name="template"
              value={t.id}
              checked={template === t.id}
              onChange={() => setTemplate(t.id)}
              className="mt-1"
            />
            <span>
              <span className="font-medium">{t.id}</span>
              <span className="block text-muted-foreground">{t.blurb}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <Button onClick={create} disabled={busy || name.trim().length < 2}>
        {busy ? "Creating…" : "Create game →"}
      </Button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
