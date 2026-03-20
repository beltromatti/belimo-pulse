"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { BrainAlert, ChatMessage, OperatorPolicy } from "@/lib/runtime-types";

type ChatPanelProps = {
  alerts: BrainAlert[];
  onDismissAlert: (alertId: string) => void;
  onPoliciesSync?: (policies: OperatorPolicy[]) => void;
};

const QUICK_ACTIONS = [
  { label: "Building Status", message: "Give me a quick overview of the building status right now." },
  { label: "Run Diagnostics", message: "Run diagnostics on all devices and report any issues." },
  { label: "Optimize Comfort", message: "Analyze all zones and make adjustments to optimize comfort." },
];

export function ChatPanel({ alerts, onDismissAlert, onPoliciesSync }: ChatPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const undismissedAlerts = alerts.filter((alert) => !alert.dismissed);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  const prevAlertCountRef = useRef(alerts.length);

  useEffect(() => {
    if (alerts.length > prevAlertCountRef.current && !isOpen) {
      const latest = alerts[alerts.length - 1];
      const severityLabel =
        latest.severity === "critical" ? "CRITICAL" : latest.severity === "warning" ? "WARNING" : "INFO";

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `${severityLabel}: ${latest.title}\n\n${latest.body}${latest.suggestedAction ? `\n\nSuggested action: ${latest.suggestedAction}` : ""}`,
          timestamp: latest.timestamp,
        },
      ]);
    }

    prevAlertCountRef.current = alerts.length;
  }, [alerts, isOpen]);

  const sendMessage = useCallback(
    async (text: string) => {
      if (!text.trim() || isLoading) {
        return;
      }

      const userMsg: ChatMessage = {
        role: "user",
        content: text.trim(),
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMsg]);
      setInput("");
      setIsLoading(true);

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: text.trim(),
            conversationId,
          }),
        });

        const data = await response.json();

        if (data.ok && data.message) {
          setMessages((prev) => [...prev, data.message]);
          if (Array.isArray(data.policies)) {
            onPoliciesSync?.(data.policies);
          }

          if (data.conversationId) {
            setConversationId(data.conversationId);
          }
        } else {
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              content: data.message?.content ?? "Sorry, I couldn't process that request.",
              timestamp: new Date().toISOString(),
            },
          ]);
        }
      } catch {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: "Connection error. Please check that the backend is running.",
            timestamp: new Date().toISOString(),
          },
        ]);
      } finally {
        setIsLoading(false);
      }
    },
    [conversationId, isLoading, onPoliciesSync],
  );

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage(input);
    }
  };

  return (
    <>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full border border-white/60 bg-[#d9691f] text-white shadow-[0_12px_40px_rgba(217,105,31,0.35)] transition-transform hover:scale-105 active:scale-95"
      >
        {isOpen ? (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        ) : (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
          </svg>
        )}
        {undismissedAlerts.length > 0 && !isOpen ? (
          <span className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-rose-500 text-[10px] font-bold text-white">
            {undismissedAlerts.length}
          </span>
        ) : null}
      </button>

      {isOpen ? (
        <div className="fixed bottom-24 right-6 z-50 flex h-[560px] w-[380px] flex-col overflow-hidden rounded-[1.4rem] border border-white/55 bg-white/88 shadow-[0_28px_80px_rgba(15,23,42,0.2)] backdrop-blur-xl">
          <div className="flex items-center justify-between border-b border-slate-200/60 bg-gradient-to-r from-[#d9691f]/8 to-transparent px-5 py-3.5">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Belimo Brain</h3>
              <p className="text-[11px] text-slate-500">AI Facility Assistant</p>
            </div>
            <div className="flex h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.6)]" />
          </div>

          {undismissedAlerts.length > 0 ? (
            <div className="border-b border-slate-200/50 bg-amber-50/60 px-4 py-2">
              {undismissedAlerts.slice(-2).map((alert) => (
                <div key={alert.id} className="flex items-start gap-2 py-1">
                  <span className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${alert.severity === "critical" ? "bg-rose-500" : alert.severity === "warning" ? "bg-amber-500" : "bg-blue-500"}`} />
                  <p className="flex-1 text-[11px] leading-tight text-slate-700">{alert.title}</p>
                  <button onClick={() => onDismissAlert(alert.id)} className="text-[10px] text-slate-400 hover:text-slate-700">
                    dismiss
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3">
            {messages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#d9691f]/10">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#d9691f" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 3v3m0 12v3M3 12h3m12 0h3m-2.636-6.364l-2.122 2.122M7.758 16.242l-2.122 2.122m0-12.728l2.122 2.122m8.486 8.486l2.122 2.122" />
                  </svg>
                </div>
                <p className="text-sm font-medium text-slate-700">Ask me anything about the building</p>
                <p className="text-xs text-slate-500">I can check zones, adjust settings, and diagnose issues.</p>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {messages.map((msg, i) => (
                  <div key={`${msg.timestamp}-${i}`} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed ${msg.role === "user" ? "bg-slate-900 text-white" : "border border-slate-200/60 bg-white text-slate-800"}`}>
                      <p className="whitespace-pre-wrap">{msg.content}</p>
                      {msg.actions && msg.actions.length > 0 ? (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {msg.actions.map((action, j) => (
                            <span key={j} className="rounded-full bg-[#d9691f]/10 px-2 py-0.5 text-[10px] font-medium text-[#d9691f]">
                              {action.tool.replace(/_/g, " ")}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))}
                {isLoading ? (
                  <div className="flex justify-start">
                    <div className="rounded-2xl border border-slate-200/60 bg-white px-4 py-3">
                      <div className="flex gap-1.5">
                        <span className="h-2 w-2 animate-bounce rounded-full bg-slate-400 [animation-delay:0ms]" />
                        <span className="h-2 w-2 animate-bounce rounded-full bg-slate-400 [animation-delay:150ms]" />
                        <span className="h-2 w-2 animate-bounce rounded-full bg-slate-400 [animation-delay:300ms]" />
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </div>

          {messages.length === 0 ? (
            <div className="flex gap-2 border-t border-slate-200/50 bg-slate-50/40 px-4 py-2.5">
              {QUICK_ACTIONS.map((action) => (
                <button
                  key={action.label}
                  onClick={() => sendMessage(action.message)}
                  disabled={isLoading}
                  className="rounded-full border border-slate-200/80 bg-white px-3 py-1.5 text-[11px] font-medium text-slate-700 transition-colors hover:border-[#d9691f]/40 hover:text-[#d9691f] disabled:opacity-50"
                >
                  {action.label}
                </button>
              ))}
            </div>
          ) : null}

          <div className="border-t border-slate-200/60 bg-white/60 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask about the building..."
                disabled={isLoading}
                className="flex-1 rounded-xl border border-slate-200/80 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder-slate-400 outline-none transition-colors focus:border-[#d9691f]/40 disabled:opacity-60"
              />
              <button
                onClick={() => sendMessage(input)}
                disabled={!input.trim() || isLoading}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#d9691f] text-white transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 2L11 13M22 2l-7 20-4-9-9-4z" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
