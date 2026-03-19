import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

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
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
  OPEN_METEO_BASE_URL: z.string().url().default("https://api.open-meteo.com/v1/forecast"),
});

export const env = envSchema.parse(process.env);

export const allowedOrigins = env.ALLOWED_ORIGINS.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
