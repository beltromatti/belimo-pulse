import { z } from "zod";

import { WeatherSnapshot } from "../physics";

const openMeteoResponseSchema = z.object({
  hourly: z.object({
    time: z.array(z.string()),
    temperature_2m: z.array(z.number().nullable()),
    relative_humidity_2m: z.array(z.number().nullable()),
    wind_speed_10m: z.array(z.number().nullable()),
    wind_direction_10m: z.array(z.number().nullable()),
    cloud_cover: z.array(z.number().nullable()),
  }),
});

export class OpenMeteoWeatherService {
  private lastFetchAt: number | null = null;

  private cachedWeather: WeatherSnapshot | null = null;

  constructor(private readonly baseUrl: string) {}

  async getWeather(latitude: number, longitude: number, timezone: string, now: Date) {
    const cacheAgeMs = this.lastFetchAt ? now.getTime() - this.lastFetchAt : Number.POSITIVE_INFINITY;

    if (!this.cachedWeather || cacheAgeMs > 15 * 60 * 1000) {
      try {
        this.cachedWeather = await this.fetchWeather(latitude, longitude, timezone, now);
        this.lastFetchAt = now.getTime();
      } catch (error) {
        if (!this.cachedWeather) {
          throw error;
        }

        this.cachedWeather = {
          ...this.cachedWeather,
          isStale: true,
        };
      }
    }

    return this.cachedWeather;
  }

  private async fetchWeather(latitude: number, longitude: number, timezone: string, now: Date) {
    const params = new URLSearchParams({
      latitude: latitude.toString(),
      longitude: longitude.toString(),
      hourly: [
        "temperature_2m",
        "relative_humidity_2m",
        "wind_speed_10m",
        "wind_direction_10m",
        "cloud_cover",
      ].join(","),
      timezone,
      forecast_days: "2",
      past_hours: "3",
    });

    const response = await fetch(`${this.baseUrl}?${params.toString()}`);

    if (!response.ok) {
      throw new Error(`Open-Meteo weather request failed with status ${response.status}`);
    }

    const payload = openMeteoResponseSchema.parse(await response.json());
    const nearestIndex = this.findNearestIndex(payload.hourly.time, now);
    const nearestValidIndex = this.findNearestValidIndex(payload.hourly, nearestIndex);

    return {
      source: "open-meteo" as const,
      observedAt: payload.hourly.time[nearestValidIndex],
      temperatureC: payload.hourly.temperature_2m[nearestValidIndex] ?? 0,
      relativeHumidityPct: payload.hourly.relative_humidity_2m[nearestValidIndex] ?? 50,
      windSpeedMps: (payload.hourly.wind_speed_10m[nearestValidIndex] ?? 0) / 3.6,
      windDirectionDeg: payload.hourly.wind_direction_10m[nearestValidIndex] ?? 0,
      cloudCoverPct: payload.hourly.cloud_cover[nearestValidIndex] ?? 0,
      isStale: false,
    };
  }

  private findNearestIndex(hourlyTimes: string[], now: Date) {
    const target = now.getTime();

    return hourlyTimes.reduce(
      (bestIndex, value, index) => {
        const delta = Math.abs(new Date(value).getTime() - target);
        return delta < bestIndex.delta ? { index, delta } : bestIndex;
      },
      { index: 0, delta: Number.POSITIVE_INFINITY },
    ).index;
  }

  private findNearestValidIndex(hourly: z.infer<typeof openMeteoResponseSchema>["hourly"], preferredIndex: number) {
    for (let radius = 0; radius < hourly.time.length; radius += 1) {
      const candidates = [preferredIndex - radius, preferredIndex + radius];

      for (const index of candidates) {
        if (index < 0 || index >= hourly.time.length) {
          continue;
        }

        if (
          hourly.temperature_2m[index] !== null &&
          hourly.relative_humidity_2m[index] !== null &&
          hourly.wind_speed_10m[index] !== null &&
          hourly.wind_direction_10m[index] !== null &&
          hourly.cloud_cover[index] !== null
        ) {
          return index;
        }
      }
    }

    throw new Error("Open-Meteo payload did not include any valid hourly weather samples");
  }
}
