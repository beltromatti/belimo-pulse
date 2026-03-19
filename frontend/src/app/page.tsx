import { BuildingGateway } from "@/components/building-gateway";
import { fetchRuntimeBootstrap } from "@/lib/backend";

export const dynamic = "force-dynamic";

export default async function Home() {
  const { bootstrap, brainAlerts, websocketUrl } = await fetchRuntimeBootstrap();

  return <BuildingGateway initial={bootstrap} initialBrainAlerts={brainAlerts} websocketUrl={websocketUrl} />;
}
