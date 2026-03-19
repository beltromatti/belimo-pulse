import { RuntimeShell } from "@/components/runtime-shell";
import { fetchRuntimeBootstrap } from "@/lib/backend";

export const dynamic = "force-dynamic";

export default async function Home() {
  const { bootstrap, brainAlerts, websocketUrl } = await fetchRuntimeBootstrap();

  return <RuntimeShell initial={bootstrap} initialBrainAlerts={brainAlerts} websocketUrl={websocketUrl} />;
}
