"use client";

import { OrbitControls, RoundedBox } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";

import { getProductModelRegistration, RuntimeDeviceModel } from "@/components/runtime-device-models";
import { DeviceDefinition, DeviceTelemetryRecord, ProductDefinition } from "@/lib/runtime-types";

function getPreviewMountType(product: ProductDefinition) {
  if (product.visualization?.mount_type) {
    return product.visualization.mount_type;
  }

  if (product.category === "actuator") {
    return "duct_shaft_side";
  }

  if (product.category === "sensor") {
    return product.subtype.includes("room") ? "wall_surface" : "duct_surface_probe";
  }

  return "equipment_base";
}

export function ProductModelPreview({
  product,
  device,
  telemetry,
}: {
  product: ProductDefinition;
  device: DeviceDefinition;
  telemetry?: DeviceTelemetryRecord["telemetry"] | null;
}) {
  const registration = getProductModelRegistration(product.id);

  return (
    <div className="relative h-[320px] overflow-hidden rounded-[1.8rem] border border-white/60 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.98),rgba(234,241,247,0.92)_48%,rgba(208,220,232,0.96)_100%)]">
      <div className="pointer-events-none absolute inset-x-5 top-4 z-10 flex items-center justify-between rounded-full border border-white/70 bg-white/80 px-4 py-2 text-[11px] font-medium uppercase tracking-[0.24em] text-slate-500 backdrop-blur">
        <span>{product.brand}</span>
        <span>{getPreviewMountType(product).replaceAll("_", " ")}</span>
      </div>
      <Canvas camera={{ position: [2.3, 1.35, 2.55], fov: 28 }} dpr={1.5} gl={{ powerPreference: "high-performance" }}>
        <color attach="background" args={["#eef4fa"]} />
        <ambientLight intensity={1.35} />
        <hemisphereLight intensity={1.1} color="#ffffff" groundColor="#d7e1ec" />
        <directionalLight position={[3.2, 5, 2.8]} intensity={2.2} />
        <directionalLight position={[-2.4, 2.2, -1.4]} intensity={0.8} color="#fff2d8" />

        <group position={[0, -0.05, 0]}>
          <RoundedBox args={[1.68, 0.08, 1.68]} radius={0.06} smoothness={4} position={[0, -0.52, 0]}>
            <meshStandardMaterial color="#dbe6f0" roughness={0.92} metalness={0.04} />
          </RoundedBox>
          <RoundedBox args={[1.1, 0.05, 1.1]} radius={0.04} smoothness={4} position={[0, -0.47, 0]}>
            <meshStandardMaterial color="#f6f9fc" roughness={0.88} metalness={0.02} />
          </RoundedBox>
        </group>

        <group rotation={registration.previewRotation} scale={registration.previewScale}>
          <RuntimeDeviceModel productId={product.id} device={device} telemetry={telemetry ?? null} />
        </group>

        <OrbitControls enablePan={false} minDistance={1.8} maxDistance={4.2} autoRotate autoRotateSpeed={1.2} />
      </Canvas>
    </div>
  );
}
