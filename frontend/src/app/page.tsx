import { BridgeTester } from "@/components/bridge-tester";

const architecture = [
  "Frontend Next.js su Vercel",
  "Backend Express + TypeScript su AWS EC2",
  "Database Postgres su Supabase",
];

export default function Home() {
  return (
    <main className="relative mx-auto flex min-h-screen w-full max-w-7xl flex-col px-6 py-10 sm:px-10 lg:px-14">
      <section className="grid gap-8 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="rounded-[2rem] border border-[var(--panel-border)] bg-[var(--panel)] p-8 shadow-[0_24px_80px_rgba(53,45,32,0.12)] backdrop-blur">
          <p className="font-mono text-sm uppercase tracking-[0.35em] text-[var(--accent-strong)]">
            Start Hackathon 2026
          </p>
          <div className="mt-8 max-w-3xl">
            <h1 className="text-5xl font-semibold tracking-[-0.04em] text-slate-950 sm:text-6xl">
              Belimo Pulse
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-[var(--muted)]">
              Frontend e backend sono predisposti per un ciclo reale di deploy:
              il bottone qui sotto passa da Vercel al backend Express e registra
              un evento nel database Supabase.
            </p>
          </div>

          <div className="mt-10 grid gap-4 sm:grid-cols-3">
            {architecture.map((item) => (
              <div
                key={item}
                className="rounded-3xl border border-[var(--panel-border)] bg-white/70 p-4"
              >
                <p className="font-mono text-xs uppercase tracking-[0.24em] text-[var(--muted)]">
                  Stack
                </p>
                <p className="mt-3 text-base font-medium text-slate-900">{item}</p>
              </div>
            ))}
          </div>
        </div>

        <aside className="rounded-[2rem] border border-slate-900 bg-slate-950 p-8 text-slate-50 shadow-[0_24px_80px_rgba(15,23,32,0.28)]">
          <p className="font-mono text-xs uppercase tracking-[0.35em] text-orange-300">
            Deployment Model
          </p>
          <div className="mt-6 space-y-6">
            <div>
              <p className="text-2xl font-semibold">Main branch only</p>
              <p className="mt-2 text-sm leading-7 text-slate-300">
                Su push a <span className="font-mono">main</span> il backend passa da GitHub Actions,
                mentre il frontend viene pubblicato dal Git integration nativo di Vercel.
              </p>
            </div>
            <div>
              <p className="text-2xl font-semibold">Server-side bridge</p>
              <p className="mt-2 text-sm leading-7 text-slate-300">
                Il frontend non chiama l&apos;EC2 dal browser: usa una route API
                Next.js, evitando problemi di mixed content e CORS in produzione.
              </p>
            </div>
          </div>
        </aside>
      </section>

      <section className="mt-8 grid gap-8 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="rounded-[2rem] border border-[var(--panel-border)] bg-white/75 p-8 backdrop-blur">
          <p className="font-mono text-xs uppercase tracking-[0.3em] text-[var(--accent-strong)]">
            End-to-end check
          </p>
          <h2 className="mt-4 text-3xl font-semibold tracking-[-0.03em] text-slate-950">
            Test frontend → backend → database
          </h2>
          <p className="mt-4 text-base leading-8 text-[var(--muted)]">
            Il test inserisce una riga in <span className="font-mono">pulse_healthchecks</span> nel
            database Supabase passando dal backend deployato sul server AWS.
          </p>
        </div>

        <BridgeTester />
      </section>
    </main>
  );
}
