import { RunViewer } from "@/components/run-viewer";

export const dynamic = "force-dynamic";

export default async function RunPage({ params }: PageProps<"/runs/[id]">) {
  const { id } = await params;
  return <RunViewer runId={id} />;
}
