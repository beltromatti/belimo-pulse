import { BuildingGateway } from "@/components/building-gateway";
import { fetchRuntimeBootstrap } from "@/lib/backend";

export const dynamic = "force-dynamic";

type HomeProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function getSearchParamValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

export default async function Home({ searchParams }: HomeProps) {
  const { bootstrap, brainAlerts, brainPolicies, websocketUrl } = await fetchRuntimeBootstrap();
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const initialSelectedBuildingId = getSearchParamValue(resolvedSearchParams.building);
  const initialView = getSearchParamValue(resolvedSearchParams.view) === "dashboard" ? "dashboard" : "portfolio";

  return (
    <BuildingGateway
      initial={bootstrap}
      initialBrainAlerts={brainAlerts}
      initialBrainPolicies={brainPolicies}
      websocketUrl={websocketUrl}
      initialSelectedBuildingId={initialSelectedBuildingId}
      initialView={initialView}
    />
  );
}
