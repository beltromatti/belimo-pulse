import { Pool, PoolClient } from "pg";

import { BuildingBlueprint } from "./blueprint";
import { env } from "./config";
import { BrainAction, BrainAlert, ChatMessage } from "./ai/types";
import {
  DeviceDiagnosis,
  DeviceTelemetryRecord,
  RuntimeControlState,
  RuntimePersistenceSummary,
  SandboxTickResult,
  TwinSnapshot,
} from "./runtime-types";
import { WeatherSnapshot } from "./physics";

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : false,
});

export async function ensureDatabaseReady() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pulse_healthchecks (
      id BIGSERIAL PRIMARY KEY,
      source TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pulse_blueprints (
      blueprint_id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      name TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      blueprint JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pulse_weather_observations (
      id BIGSERIAL PRIMARY KEY,
      building_id TEXT NOT NULL,
      observed_at TIMESTAMPTZ NOT NULL,
      weather JSONB NOT NULL
    );

    CREATE INDEX IF NOT EXISTS pulse_weather_observations_lookup_idx
      ON pulse_weather_observations (building_id, observed_at DESC);

    CREATE TABLE IF NOT EXISTS pulse_device_observations (
      id BIGSERIAL PRIMARY KEY,
      building_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      device_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      observed_at TIMESTAMPTZ NOT NULL,
      telemetry JSONB NOT NULL
    );

    CREATE INDEX IF NOT EXISTS pulse_device_observations_lookup_idx
      ON pulse_device_observations (building_id, observed_at DESC, device_id);

    CREATE TABLE IF NOT EXISTS pulse_twin_snapshots (
      id BIGSERIAL PRIMARY KEY,
      building_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      observed_at TIMESTAMPTZ NOT NULL,
      summary JSONB NOT NULL,
      weather JSONB NOT NULL,
      zones JSONB NOT NULL,
      devices JSONB NOT NULL,
      derived JSONB NOT NULL
    );

    CREATE INDEX IF NOT EXISTS pulse_twin_snapshots_lookup_idx
      ON pulse_twin_snapshots (building_id, observed_at DESC);

    ALTER TABLE pulse_twin_snapshots
      ADD COLUMN IF NOT EXISTS controls JSONB,
      ADD COLUMN IF NOT EXISTS operational_state JSONB,
      ADD COLUMN IF NOT EXISTS active_faults JSONB;

    CREATE TABLE IF NOT EXISTS pulse_runtime_frames (
      id BIGSERIAL PRIMARY KEY,
      building_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      observed_at TIMESTAMPTZ NOT NULL,
      controls JSONB NOT NULL,
      operational_state JSONB NOT NULL,
      active_faults JSONB NOT NULL
    );

    CREATE INDEX IF NOT EXISTS pulse_runtime_frames_lookup_idx
      ON pulse_runtime_frames (building_id, observed_at DESC);

    CREATE TABLE IF NOT EXISTS pulse_zone_twin_observations (
      id BIGSERIAL PRIMARY KEY,
      building_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      zone_id TEXT NOT NULL,
      observed_at TIMESTAMPTZ NOT NULL,
      temperature_c DOUBLE PRECISION NOT NULL,
      relative_humidity_pct DOUBLE PRECISION NOT NULL,
      co2_ppm DOUBLE PRECISION NOT NULL,
      occupancy_count INTEGER NOT NULL,
      supply_airflow_m3_h DOUBLE PRECISION NOT NULL,
      sensible_load_w DOUBLE PRECISION NOT NULL,
      comfort_score DOUBLE PRECISION NOT NULL
    );

    CREATE INDEX IF NOT EXISTS pulse_zone_twin_observations_lookup_idx
      ON pulse_zone_twin_observations (building_id, zone_id, observed_at DESC);

    CREATE TABLE IF NOT EXISTS pulse_device_diagnoses (
      id BIGSERIAL PRIMARY KEY,
      building_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      device_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      observed_at TIMESTAMPTZ NOT NULL,
      health_score DOUBLE PRECISION NOT NULL,
      alerts JSONB NOT NULL,
      metrics JSONB NOT NULL
    );

    CREATE INDEX IF NOT EXISTS pulse_device_diagnoses_lookup_idx
      ON pulse_device_diagnoses (building_id, device_id, observed_at DESC);

    CREATE TABLE IF NOT EXISTS pulse_facility_preferences (
      building_id TEXT PRIMARY KEY,
      preferences JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pulse_control_events (
      id BIGSERIAL PRIMARY KEY,
      building_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS pulse_control_events_lookup_idx
      ON pulse_control_events (building_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS pulse_belimo_brain_conversations (
      conversation_id TEXT PRIMARY KEY,
      building_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS pulse_belimo_brain_conversations_lookup_idx
      ON pulse_belimo_brain_conversations (building_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS pulse_belimo_brain_messages (
      id BIGSERIAL PRIMARY KEY,
      building_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      actions JSONB NOT NULL DEFAULT '[]'::jsonb,
      message_timestamp TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS pulse_belimo_brain_messages_lookup_idx
      ON pulse_belimo_brain_messages (building_id, conversation_id, message_timestamp DESC, id DESC);

    CREATE TABLE IF NOT EXISTS pulse_belimo_brain_alerts (
      id TEXT PRIMARY KEY,
      building_id TEXT NOT NULL,
      source TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      suggested_action TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      alert_timestamp TIMESTAMPTZ NOT NULL,
      dismissed BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS pulse_belimo_brain_alerts_lookup_idx
      ON pulse_belimo_brain_alerts (building_id, dismissed, alert_timestamp DESC);
  `);
}

export async function getDatabaseHealth() {
  const result = await pool.query<{
    now: string;
    current_database: string;
    current_user: string;
  }>(`
    SELECT
      NOW()::TEXT AS now,
      CURRENT_DATABASE() AS current_database,
      CURRENT_USER AS current_user
  `);

  return result.rows[0];
}

export async function createHealthcheck(source: string, note: string) {
  const result = await pool.query<{
    id: string;
    source: string;
    note: string;
    created_at: string;
  }>(
    `
      INSERT INTO pulse_healthchecks (source, note)
      VALUES ($1, $2)
      RETURNING id::TEXT, source, note, created_at::TEXT
    `,
    [source, note],
  );

  return result.rows[0];
}

export async function upsertBlueprintRecord(blueprint: BuildingBlueprint) {
  await pool.query(
    `
      INSERT INTO pulse_blueprints (blueprint_id, source_type, name, schema_version, blueprint)
      VALUES ($1, $2, $3, $4, $5::jsonb)
      ON CONFLICT (blueprint_id) DO UPDATE
      SET
        source_type = EXCLUDED.source_type,
        name = EXCLUDED.name,
        schema_version = EXCLUDED.schema_version,
        blueprint = EXCLUDED.blueprint,
        updated_at = NOW()
    `,
    [
      blueprint.blueprint_id,
      blueprint.source_type,
      blueprint.building.name,
      blueprint.schema_version,
      JSON.stringify(blueprint),
    ],
  );
}

export async function insertWeatherObservation(buildingId: string, observedAt: string, weather: WeatherSnapshot) {
  await pool.query(
    `
      INSERT INTO pulse_weather_observations (building_id, observed_at, weather)
      VALUES ($1, $2, $3::jsonb)
    `,
    [buildingId, observedAt, JSON.stringify(weather)],
  );
}

export async function insertDeviceObservations(
  buildingId: string,
  observedAt: string,
  sourceKind: "sandbox" | "real",
  records: DeviceTelemetryRecord[],
) {
  if (records.length === 0) {
    return;
  }

  const values: string[] = [];
  const params: Array<string> = [];

  records.forEach((record, index) => {
    const offset = index * 6;
    values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}::jsonb)`);
    params.push(
      buildingId,
      sourceKind,
      record.deviceId,
      record.productId,
      observedAt,
      JSON.stringify(record.telemetry),
    );
  });

  await pool.query(
    `
      INSERT INTO pulse_device_observations (
        building_id,
        source_kind,
        device_id,
        product_id,
        observed_at,
        telemetry
      )
      VALUES ${values.join(", ")}
    `,
    params,
  );
}

export async function insertTwinSnapshot(snapshot: TwinSnapshot) {
  await pool.query(
    `
      INSERT INTO pulse_twin_snapshots (
        building_id,
        source_kind,
        observed_at,
        summary,
        weather,
        zones,
        devices,
        derived,
        controls,
        operational_state,
        active_faults
      )
      VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb)
    `,
    [
      snapshot.buildingId,
      snapshot.sourceKind,
      snapshot.observedAt,
      JSON.stringify(snapshot.summary),
      JSON.stringify(snapshot.weather),
      JSON.stringify(snapshot.zones),
      JSON.stringify(snapshot.devices),
      JSON.stringify(snapshot.derived),
      JSON.stringify({}),
      JSON.stringify({}),
      JSON.stringify([]),
    ],
  );
}

async function insertZoneTwinObservationsWithClient(client: PoolClient, snapshot: TwinSnapshot) {
  if (snapshot.zones.length === 0) {
    return;
  }

  const values: string[] = [];
  const params: Array<string | number> = [];

  snapshot.zones.forEach((zone, index) => {
    const offset = index * 11;
    values.push(
      `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11})`,
    );
    params.push(
      snapshot.buildingId,
      snapshot.sourceKind,
      zone.zoneId,
      snapshot.observedAt,
      zone.temperatureC,
      zone.relativeHumidityPct,
      zone.co2Ppm,
      zone.occupancyCount,
      zone.supplyAirflowM3H,
      zone.sensibleLoadW,
      zone.comfortScore,
    );
  });

  await client.query(
    `
      INSERT INTO pulse_zone_twin_observations (
        building_id,
        source_kind,
        zone_id,
        observed_at,
        temperature_c,
        relative_humidity_pct,
        co2_ppm,
        occupancy_count,
        supply_airflow_m3_h,
        sensible_load_w,
        comfort_score
      )
      VALUES ${values.join(", ")}
    `,
    params,
  );
}

async function insertDeviceDiagnosesWithClient(client: PoolClient, snapshot: TwinSnapshot) {
  if (snapshot.devices.length === 0) {
    return;
  }

  const values: string[] = [];
  const params: Array<string | number> = [];

  snapshot.devices.forEach((device, index) => {
    const offset = index * 8;
    values.push(
      `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}::jsonb, $${offset + 8}::jsonb)`,
    );
    params.push(
      snapshot.buildingId,
      snapshot.sourceKind,
      device.deviceId,
      device.productId,
      snapshot.observedAt,
      device.healthScore,
      JSON.stringify(device.alerts),
      JSON.stringify(device.metrics),
    );
  });

  await client.query(
    `
      INSERT INTO pulse_device_diagnoses (
        building_id,
        source_kind,
        device_id,
        product_id,
        observed_at,
        health_score,
        alerts,
        metrics
      )
      VALUES ${values.join(", ")}
    `,
    params,
  );
}

export async function insertRuntimeArtifacts(input: {
  batch: SandboxTickResult;
  snapshot: TwinSnapshot;
  controls: RuntimeControlState;
}) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `
        INSERT INTO pulse_weather_observations (building_id, observed_at, weather)
        VALUES ($1, $2, $3::jsonb)
      `,
      [input.batch.buildingId, input.batch.observedAt, JSON.stringify(input.batch.weather)],
    );

    if (input.batch.deviceReadings.length > 0) {
      const values: string[] = [];
      const params: Array<string> = [];

      input.batch.deviceReadings.forEach((record, index) => {
        const offset = index * 6;
        values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}::jsonb)`);
        params.push(
          input.batch.buildingId,
          input.snapshot.sourceKind,
          record.deviceId,
          record.productId,
          input.batch.observedAt,
          JSON.stringify(record.telemetry),
        );
      });

      await client.query(
        `
          INSERT INTO pulse_device_observations (
            building_id,
            source_kind,
            device_id,
            product_id,
            observed_at,
            telemetry
          )
          VALUES ${values.join(", ")}
        `,
        params,
      );
    }

    await client.query(
      `
        INSERT INTO pulse_twin_snapshots (
          building_id,
          source_kind,
          observed_at,
          summary,
          weather,
          zones,
          devices,
          derived,
          controls,
          operational_state,
          active_faults
        )
        VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb)
      `,
      [
        input.snapshot.buildingId,
        input.snapshot.sourceKind,
        input.snapshot.observedAt,
        JSON.stringify(input.snapshot.summary),
        JSON.stringify(input.snapshot.weather),
        JSON.stringify(input.snapshot.zones),
        JSON.stringify(input.snapshot.devices),
        JSON.stringify(input.snapshot.derived),
        JSON.stringify(input.controls),
        JSON.stringify(input.batch.operationalState),
        JSON.stringify(input.batch.operationalState.activeFaults),
      ],
    );

    await client.query(
      `
        INSERT INTO pulse_runtime_frames (
          building_id,
          source_kind,
          observed_at,
          controls,
          operational_state,
          active_faults
        )
        VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb)
      `,
      [
        input.batch.buildingId,
        input.snapshot.sourceKind,
        input.batch.observedAt,
        JSON.stringify(input.controls),
        JSON.stringify(input.batch.operationalState),
        JSON.stringify(input.batch.operationalState.activeFaults),
      ],
    );

    await insertZoneTwinObservationsWithClient(client, input.snapshot);
    await insertDeviceDiagnosesWithClient(client, input.snapshot);

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function upsertFacilityPreferences(buildingId: string, preferences: RuntimeControlState) {
  await pool.query(
    `
      INSERT INTO pulse_facility_preferences (building_id, preferences)
      VALUES ($1, $2::jsonb)
      ON CONFLICT (building_id) DO UPDATE
      SET preferences = EXCLUDED.preferences, updated_at = NOW()
    `,
    [buildingId, JSON.stringify(preferences)],
  );
}

export async function insertControlEvent(
  buildingId: string,
  actor: string,
  eventType: string,
  payload: Record<string, unknown>,
) {
  await pool.query(
    `
      INSERT INTO pulse_control_events (building_id, actor, event_type, payload)
      VALUES ($1, $2, $3, $4::jsonb)
    `,
    [buildingId, actor, eventType, JSON.stringify(payload)],
  );
}

async function upsertBelimoBrainConversation(
  client: PoolClient | Pool,
  buildingId: string,
  conversationId: string,
) {
  await client.query(
    `
      INSERT INTO pulse_belimo_brain_conversations (conversation_id, building_id)
      VALUES ($1, $2)
      ON CONFLICT (conversation_id) DO UPDATE
      SET building_id = EXCLUDED.building_id, updated_at = NOW()
    `,
    [conversationId, buildingId],
  );
}

export async function insertBelimoBrainMessages(
  buildingId: string,
  conversationId: string,
  messages: ChatMessage[],
) {
  if (messages.length === 0) {
    return;
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await upsertBelimoBrainConversation(client, buildingId, conversationId);

    const values: string[] = [];
    const params: Array<string> = [];

    messages.forEach((message, index) => {
      const offset = index * 6;
      values.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}::jsonb, $${offset + 6})`,
      );
      params.push(
        buildingId,
        conversationId,
        message.role,
        message.content,
        JSON.stringify(message.actions ?? []),
        message.timestamp,
      );
    });

    await client.query(
      `
        INSERT INTO pulse_belimo_brain_messages (
          building_id,
          conversation_id,
          role,
          content,
          actions,
          message_timestamp
        )
        VALUES ${values.join(", ")}
      `,
      params,
    );

    await client.query(
      `
        UPDATE pulse_belimo_brain_conversations
        SET updated_at = NOW()
        WHERE conversation_id = $1
      `,
      [conversationId],
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listBelimoBrainConversationMessages(
  buildingId: string,
  conversationId: string,
  limit = 40,
) {
  const result = await pool.query<{
    role: ChatMessage["role"];
    content: string;
    actions: BrainAction[] | null;
    message_timestamp: string;
  }>(
    `
      SELECT
        role,
        content,
        actions,
        message_timestamp::TEXT
      FROM pulse_belimo_brain_messages
      WHERE building_id = $1 AND conversation_id = $2
      ORDER BY message_timestamp DESC, id DESC
      LIMIT $3
    `,
    [buildingId, conversationId, limit],
  );

  return result.rows
    .reverse()
    .map((row) => ({
      role: row.role,
      content: row.content,
      actions: Array.isArray(row.actions) && row.actions.length > 0 ? (row.actions as ChatMessage["actions"]) : undefined,
      timestamp: row.message_timestamp,
    })) satisfies ChatMessage[];
}

export async function insertBelimoBrainAlert(
  buildingId: string,
  alert: BrainAlert,
  source: string,
  metadata: Record<string, unknown> = {},
) {
  await pool.query(
    `
      INSERT INTO pulse_belimo_brain_alerts (
        id,
        building_id,
        source,
        severity,
        title,
        body,
        suggested_action,
        metadata,
        alert_timestamp,
        dismissed
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
    `,
    [
      alert.id,
      buildingId,
      source,
      alert.severity,
      alert.title,
      alert.body,
      alert.suggestedAction ?? null,
      JSON.stringify(metadata),
      alert.timestamp,
      alert.dismissed,
    ],
  );
}

export async function listActiveBelimoBrainAlerts(buildingId: string, limit = 50) {
  const result = await pool.query<{
    id: string;
    severity: BrainAlert["severity"];
    title: string;
    body: string;
    suggested_action: string | null;
    alert_timestamp: string;
    dismissed: boolean;
  }>(
    `
      SELECT
        id,
        severity,
        title,
        body,
        suggested_action,
        alert_timestamp::TEXT,
        dismissed
      FROM pulse_belimo_brain_alerts
      WHERE building_id = $1 AND dismissed = FALSE
      ORDER BY alert_timestamp ASC, created_at ASC
      LIMIT $2
    `,
    [buildingId, limit],
  );

  return result.rows.map((row) => ({
    id: row.id,
    severity: row.severity,
    title: row.title,
    body: row.body,
    suggestedAction: row.suggested_action ?? undefined,
    timestamp: row.alert_timestamp,
    dismissed: row.dismissed,
  })) satisfies BrainAlert[];
}

export async function dismissBelimoBrainAlert(buildingId: string, alertId: string) {
  await pool.query(
    `
      UPDATE pulse_belimo_brain_alerts
      SET dismissed = TRUE, updated_at = NOW()
      WHERE building_id = $1 AND id = $2
    `,
    [buildingId, alertId],
  );
}

export async function listRecentTwinSnapshotSummaries(buildingId: string, limit: number) {
  const result = await pool.query<{
    observed_at: string;
    summary: TwinSnapshot["summary"];
    derived: TwinSnapshot["derived"];
    controls: RuntimeControlState | null;
    active_faults: SandboxTickResult["operationalState"]["activeFaults"] | null;
  }>(
    `
      SELECT
        observed_at::TEXT,
        summary,
        derived,
        controls,
        active_faults
      FROM pulse_twin_snapshots
      WHERE building_id = $1
      ORDER BY observed_at DESC, id DESC
      LIMIT $2
    `,
    [buildingId, limit],
  );

  return result.rows;
}

export async function listRecentDeviceTelemetryHistory(buildingId: string, deviceId: string, limit: number) {
  const result = await pool.query<{
    observed_at: string;
    product_id: string;
    telemetry: DeviceTelemetryRecord["telemetry"];
  }>(
    `
      SELECT
        observed_at::TEXT,
        product_id,
        telemetry
      FROM pulse_device_observations
      WHERE building_id = $1 AND device_id = $2
      ORDER BY observed_at DESC, id DESC
      LIMIT $3
    `,
    [buildingId, deviceId, limit],
  );

  return result.rows;
}

export async function listRecentDeviceObservations(buildingId: string, limit: number) {
  const result = await pool.query<{
    device_id: string;
    product_id: string;
    observed_at: string;
    telemetry: Record<string, unknown>;
  }>(
    `
      SELECT
        device_id,
        product_id,
        observed_at::TEXT,
        telemetry
      FROM pulse_device_observations
      WHERE building_id = $1
      ORDER BY observed_at DESC, id DESC
      LIMIT $2
    `,
    [buildingId, limit],
  );

  return result.rows;
}

export async function getLatestTwinSnapshot(buildingId: string) {
  const result = await pool.query<{
    building_id: string;
    source_kind: "sandbox" | "real";
    observed_at: string;
    summary: TwinSnapshot["summary"];
    weather: TwinSnapshot["weather"];
    zones: TwinSnapshot["zones"];
    devices: TwinSnapshot["devices"];
    derived: TwinSnapshot["derived"];
  }>(
    `
      SELECT
        building_id,
        source_kind,
        observed_at::TEXT,
        summary,
        weather,
        zones,
        devices,
        derived
      FROM pulse_twin_snapshots
      WHERE building_id = $1
      ORDER BY observed_at DESC, id DESC
      LIMIT 1
    `,
    [buildingId],
  );

  const row = result.rows[0];

  if (!row) {
    return null;
  }

  return {
    buildingId: row.building_id,
    sourceKind: row.source_kind,
    observedAt: row.observed_at,
    summary: row.summary,
    weather: row.weather,
    zones: row.zones,
    devices: row.devices,
    derived: row.derived,
  } satisfies TwinSnapshot;
}

export async function getRuntimePersistenceSummary(buildingId: string) {
  const result = await pool.query<{
    rawWeatherSamples: number;
    rawDeviceSamples: number;
    twinSnapshots: number;
    runtimeFrames: number;
    zoneTwinSamples: number;
    deviceDiagnosisSamples: number;
    last_persisted_observed_at: string | null;
  }>(
    `
      SELECT
        (SELECT COUNT(*)::INT FROM pulse_weather_observations WHERE building_id = $1) AS "rawWeatherSamples",
        (SELECT COUNT(*)::INT FROM pulse_device_observations WHERE building_id = $1) AS "rawDeviceSamples",
        (SELECT COUNT(*)::INT FROM pulse_twin_snapshots WHERE building_id = $1) AS "twinSnapshots",
        (SELECT COUNT(*)::INT FROM pulse_runtime_frames WHERE building_id = $1) AS "runtimeFrames",
        (SELECT COUNT(*)::INT FROM pulse_zone_twin_observations WHERE building_id = $1) AS "zoneTwinSamples",
        (SELECT COUNT(*)::INT FROM pulse_device_diagnoses WHERE building_id = $1) AS "deviceDiagnosisSamples",
        (
          SELECT MAX(observed_at)::TEXT
          FROM (
            SELECT observed_at FROM pulse_runtime_frames WHERE building_id = $1
            UNION ALL
            SELECT observed_at FROM pulse_twin_snapshots WHERE building_id = $1
          ) observed
        ) AS last_persisted_observed_at
    `,
    [buildingId],
  );

  const row = result.rows[0];

  return {
    rawWeatherSamples: row?.rawWeatherSamples ?? 0,
    rawDeviceSamples: row?.rawDeviceSamples ?? 0,
    twinSnapshots: row?.twinSnapshots ?? 0,
    runtimeFrames: row?.runtimeFrames ?? 0,
    zoneTwinSamples: row?.zoneTwinSamples ?? 0,
    deviceDiagnosisSamples: row?.deviceDiagnosisSamples ?? 0,
    lastPersistedObservedAt: row?.last_persisted_observed_at ?? null,
  } satisfies RuntimePersistenceSummary;
}

export async function listRecentRuntimeFrames(buildingId: string, limit: number) {
  const result = await pool.query<{
    observed_at: string;
    source_kind: "sandbox" | "real";
    controls: RuntimeControlState;
    operational_state: SandboxTickResult["operationalState"];
    active_faults: SandboxTickResult["operationalState"]["activeFaults"];
  }>(
    `
      SELECT
        observed_at::TEXT,
        source_kind,
        controls,
        operational_state,
        active_faults
      FROM pulse_runtime_frames
      WHERE building_id = $1
      ORDER BY observed_at DESC, id DESC
      LIMIT $2
    `,
    [buildingId, limit],
  );

  return result.rows;
}

export async function listRecentZoneTwinObservations(buildingId: string, zoneId: string, limit: number) {
  const result = await pool.query<{
    observed_at: string;
    source_kind: "sandbox" | "real";
    zone_id: string;
    temperature_c: number;
    relative_humidity_pct: number;
    co2_ppm: number;
    occupancy_count: number;
    supply_airflow_m3_h: number;
    sensible_load_w: number;
    comfort_score: number;
  }>(
    `
      SELECT
        observed_at::TEXT,
        source_kind,
        zone_id,
        temperature_c,
        relative_humidity_pct,
        co2_ppm,
        occupancy_count,
        supply_airflow_m3_h,
        sensible_load_w,
        comfort_score
      FROM pulse_zone_twin_observations
      WHERE building_id = $1 AND zone_id = $2
      ORDER BY observed_at DESC, id DESC
      LIMIT $3
    `,
    [buildingId, zoneId, limit],
  );

  return result.rows;
}

export async function listRecentDeviceDiagnoses(buildingId: string, deviceId: string, limit: number) {
  const result = await pool.query<{
    observed_at: string;
    source_kind: "sandbox" | "real";
    device_id: string;
    product_id: string;
    health_score: number;
    alerts: string[];
    metrics: DeviceDiagnosis["metrics"];
  }>(
    `
      SELECT
        observed_at::TEXT,
        source_kind,
        device_id,
        product_id,
        health_score,
        alerts,
        metrics
      FROM pulse_device_diagnoses
      WHERE building_id = $1 AND device_id = $2
      ORDER BY observed_at DESC, id DESC
      LIMIT $3
    `,
    [buildingId, deviceId, limit],
  );

  return result.rows;
}

export async function closeDatabase() {
  await pool.end();
}
