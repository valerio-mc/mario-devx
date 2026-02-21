import type { Plugin } from "@opencode-ai/plugin";
import { createCommands } from "./commands";
import { createTools } from "./tools";
import { markSessionIdle } from "./session-idle-signal";
import { readRunState } from "./state";
import { clearToastStreamChannel, flushToastStream, ingestToastStreamEvent } from "./toast-stream";

const STREAM_TOAST_INTERVAL_MS = 3500;

const getIdleSessionId = (event: unknown): string | null => {
  if (!event || typeof event !== "object") {
    return null;
  }
  const e = event as { type?: unknown; properties?: unknown };
  if (e.type !== "session.idle") {
    return null;
  }
  const props = e.properties as { sessionID?: unknown } | undefined;
  return typeof props?.sessionID === "string" && props.sessionID.length > 0 ? props.sessionID : null;
};

const safePluginLog = async (
  client: { app?: { log?: (args: { body: { service: string; level: "info"; message: string; extra?: Record<string, unknown> } }) => Promise<unknown> } },
  message: string,
  extra?: Record<string, unknown>,
): Promise<void> => {
  try {
    if (client.app?.log) {
      await client.app.log({
        body: {
          service: "mario-devx",
          level: "info",
          message,
          extra,
        },
      });
    }
  } catch {
    // Best-effort logging only.
  }
};

const safeShowToast = async (
  client: { tui?: { showToast?: (args: { body: { message: string; variant: "info" | "success" | "warning" | "error" } }) => Promise<unknown> } },
  message: string,
  variant: "info" | "success" | "warning" | "error" = "info",
): Promise<void> => {
  try {
    if (client.tui?.showToast) {
      await client.tui.showToast({
        body: {
          message,
          variant,
        },
      });
    }
  } catch {
    // Best-effort notifications only.
  }
};

export const marioDevxPlugin: Plugin = async (ctx) => {
  const { client, directory, worktree } = ctx;
  const repoRoot = worktree ?? directory;
  const tools = createTools(ctx);
  const commands = createCommands();

  await safePluginLog(client, "Plugin initialized", {
    directory,
    worktree: repoRoot,
  });

  return {
    tool: tools,
    event: async ({ event }) => {
      const idleSessionID = getIdleSessionId(event);
      if (idleSessionID) {
        markSessionIdle(idleSessionID);
      }

      const run = await readRunState(repoRoot);
      if (run.status !== "DOING") {
        if (run.controlSessionId) {
          clearToastStreamChannel(run.controlSessionId);
        }
        return;
      }
      const workSessionId = run.workSessionId;
      const verifierSessionId = run.verifierSessionId;
      if (!workSessionId && !verifierSessionId) {
        if (run.controlSessionId) {
          clearToastStreamChannel(run.controlSessionId);
        }
        return;
      }
      if (!run.controlSessionId) {
        return;
      }

      if (idleSessionID && idleSessionID === workSessionId) {
        await flushToastStream({
          controlSessionId: run.controlSessionId,
          phase: "work",
          force: true,
          minIntervalMs: STREAM_TOAST_INTERVAL_MS,
          notify: async ({ message, variant }) => safeShowToast(client, message, variant),
        });
        return;
      }
      if (idleSessionID && idleSessionID === verifierSessionId) {
        await flushToastStream({
          controlSessionId: run.controlSessionId,
          phase: "verify",
          force: true,
          minIntervalMs: STREAM_TOAST_INTERVAL_MS,
          notify: async ({ message, variant }) => safeShowToast(client, message, variant),
        });
        return;
      }

      const accepted = ingestToastStreamEvent({
        controlSessionId: run.controlSessionId,
        event,
        ...(workSessionId ? { workSessionId } : {}),
        ...(verifierSessionId ? { verifierSessionId } : {}),
        streamWorkEvents: run.streamWorkEvents,
        streamVerifyEvents: run.streamVerifyEvents,
        ...(run.currentPI ? { taskId: run.currentPI } : {}),
      });
      if (!accepted.accepted) return;

      await flushToastStream({
        controlSessionId: run.controlSessionId,
        phase: accepted.phase,
        force: accepted.forceFlush,
        minIntervalMs: STREAM_TOAST_INTERVAL_MS,
        notify: async ({ message, variant }) => safeShowToast(client, message, variant),
      });
    },
    config: async (config) => {
      config.command = config.command ?? {};
      for (const command of commands) {
        config.command[command.name] = command.definition;
      }
      await safePluginLog(client, "Commands registered", {
        commandCount: commands.length,
      });
    },
  };
};

export default marioDevxPlugin;
