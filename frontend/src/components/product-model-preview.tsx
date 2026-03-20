"use client";

import { OrbitControls } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { useEffect, useRef, useState } from "react";

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
  compact = false,
  interactive = true,
}: {
  product: ProductDefinition;
  device: DeviceDefinition;
  telemetry?: DeviceTelemetryRecord["telemetry"] | null;
  compact?: boolean;
  interactive?: boolean;
}) {
  const registration = getProductModelRegistration(product.id);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [shouldRenderCanvas, setShouldRenderCanvas] = useState(!compact);

  useEffect(() => {
    if (!compact) {
      setShouldRenderCanvas(true);
      return;
    }

    const element = containerRef.current;

    if (!element || typeof IntersectionObserver === "undefined") {
      setShouldRenderCanvas(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        setShouldRenderCanvas(Boolean(entry?.isIntersecting));
      },
      {
        rootMargin: "220px 0px",
        threshold: 0.01,
      },
    );

    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [compact]);

  return (
    <div
      ref={containerRef}
      className={`relative overflow-hidden border border-white/60 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.98),rgba(234,241,247,0.92)_48%,rgba(208,220,232,0.96)_100%)] ${
        compact ? "h-[104px] rounded-[1.15rem]" : "h-[320px] rounded-[1.8rem]"
      } ${interactive ? "" : "pointer-events-none"}`}
    >
      {shouldRenderCanvas ? (
        <Canvas
          camera={compact ? { position: [2.95, 1.6, 3.2], fov: 30 } : { position: [2.95, 1.6, 3.2], fov: 28 }}
          dpr={compact ? 1 : 1.5}
          gl={{ powerPreference: "high-performance" }}
        >
          <color attach="background" args={["#eef4fa"]} />
          <ambientLight intensity={1.35} />
          <hemisphereLight intensity={1.1} color="#ffffff" groundColor="#d7e1ec" />
          <directionalLight position={[3.2, 5, 2.8]} intensity={2.2} />
          <directionalLight position={[-2.4, 2.2, -1.4]} intensity={0.8} color="#fff2d8" />

          <group
            rotation={registration.previewRotation}
            scale={compact ? registration.previewScale * 0.76 : registration.previewScale}
            position={compact ? [0, -0.02, 0] : [0, 0, 0]}
          >
            <RuntimeDeviceModel productId={product.id} device={device} telemetry={telemetry ?? null} />
          </group>

          <OrbitControls
            enablePan={false}
            enableRotate={interactive && !compact}
            enableZoom={false}
            minDistance={2.4}
            maxDistance={5.2}
            autoRotate
            autoRotateSpeed={compact ? 1.3 : 1.2}
          />
        </Canvas>
      ) : null}
      {!compact ? (
        <div className="pointer-events-none absolute inset-x-5 top-4 z-10 flex items-center justify-between rounded-full border border-white/70 bg-white/80 px-4 py-2 text-[11px] font-medium uppercase tracking-[0.24em] text-slate-500 backdrop-blur">
          <span>{product.brand}</span>
          <span>{getPreviewMountType(product).replaceAll("_", " ")}</span>
        </div>
      ) : null}
    </div>
  );
}
