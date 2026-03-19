"use client";

import Image from "next/image";

type BrandLockupProps = {
  className?: string;
  logoClassName?: string;
  pulseClassName?: string;
};

export function BrandLockup({ className = "", logoClassName = "", pulseClassName = "" }: BrandLockupProps) {
  return (
    <div className={`flex items-start gap-3 ${className}`.trim()}>
      <Image
        src="/logo.png"
        alt="Belimo"
        width={147}
        height={58}
        priority
        className={`h-7 w-auto sm:h-8 ${logoClassName}`.trim()}
      />
      <span
        className={`mt-[0.72rem] leading-none text-[0.78rem] font-semibold uppercase tracking-[0.42em] text-[#d9691f] sm:mt-[0.82rem] sm:text-[0.82rem] ${pulseClassName}`.trim()}
      >
        PULSE
      </span>
    </div>
  );
}
