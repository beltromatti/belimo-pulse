export type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
  actions?: BrainAction[];
  timestamp: string;
};

export type BrainAction = {
  tool: string;
  input: Record<string, unknown>;
  result: unknown;
};

export type BrainAlert = {
  id: string;
  severity: "info" | "warning" | "critical";
  title: string;
  body: string;
  suggestedAction?: string;
  timestamp: string;
  dismissed: boolean;
};

export type ChatResponse = {
  message: ChatMessage;
  conversationId: string;
  alerts: BrainAlert[];
};
