import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

function normalizeEnvValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed[0] === trimmed.at(-1) && (trimmed[0] === `"` || trimmed[0] === `'`)) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

const normalizedProcessEnv = Object.fromEntries(
  Object.entries(process.env).map(([key, value]) => [key, typeof value === "string" ? normalizeEnvValue(value) : value]),
);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_SSL: z
    .string()
    .default("true")
    .transform((value) => value === "true"),
  ALLOWED_ORIGINS: z.string().default("http://localhost:3000"),
  OPENAI_API_KEY: z
    .string()
    .min(1, "OPENAI_API_KEY is required")
    .transform((value) => value.trim()),
  OPENAI_MODEL: z.string().default("gpt-5.4"),
  OPENAI_REASONING_EFFORT: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).default("medium"),
  BELIMO_BRAIN_ANALYSIS_INTERVAL_TICKS: z.coerce.number().int().min(1).max(720).default(12),
  OPEN_METEO_BASE_URL: z.string().url().default("https://api.open-meteo.com/v1/forecast"),
});

export const env = envSchema.parse(normalizedProcessEnv);

export const allowedOrigins = env.ALLOWED_ORIGINS.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
