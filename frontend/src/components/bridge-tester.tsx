"use client";

import { useState, useTransition } from "react";

type BridgeResponse = {
  ok: boolean;
  bridgeTimestamp?: string;
  backend?: {
    ok: boolean;
    created: {
      id: string;
      source: string;
      note: string;
      created_at: string;
    };
  };
  database?: {
    ok: boolean;
    database: {
      now: string;
      current_database: string;
      current_user: string;
    };
  };
  message?: string;
};

export function BridgeTester() {
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<BridgeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runTest = () => {
    startTransition(async () => {
      setError(null);

      try {
        const response = await fetch("/api/bridge/test", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            source: "frontend-ui",
            note: "manual-bridge-test",
          }),
        });

        const payload = (await response.json()) as BridgeResponse;

        if (!response.ok || !payload.ok) {
          setResult(null);
          setError(payload.message ?? "Bridge test failed.");
          return;
        }

        setResult(payload);
      } catch (caughtError) {
        setResult(null);
        setError(caughtError instanceof Error ? caughtError.message : "Unexpected frontend error.");
      }
    });
  };

  return (
    <div className="rounded-[2rem] border border-slate-900 bg-slate-900 p-8 text-slate-50 shadow-[0_24px_80px_rgba(15,23,32,0.25)]">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.3em] text-orange-300">
            Bridge Trigger
          </p>
          <h3 className="mt-3 text-2xl font-semibold">Launch test write</h3>
        </div>
        <button
          type="button"
          onClick={runTest}
          disabled={isPending}
          className="rounded-full bg-orange-400 px-6 py-3 text-sm font-semibold text-slate-950 transition hover:bg-orange-300 disabled:cursor-wait disabled:opacity-70"
        >
          {isPending ? "Testing..." : "Run live test"}
        </button>
      </div>

      <div className="mt-8 rounded-[1.5rem] border border-white/10 bg-black/20 p-5">
        <p className="font-mono text-xs uppercase tracking-[0.28em] text-slate-400">
          Response
        </p>
        {error ? (
          <p className="mt-4 text-sm leading-7 text-rose-300">{error}</p>
        ) : result ? (
          <pre className="mt-4 overflow-x-auto text-sm leading-7 text-slate-200">
            {JSON.stringify(result, null, 2)}
          </pre>
        ) : (
          <p className="mt-4 text-sm leading-7 text-slate-300">
            Nessun test eseguito ancora. Premi il bottone per verificare il
            passaggio completo.
          </p>
        )}
      </div>
    </div>
  );
}
