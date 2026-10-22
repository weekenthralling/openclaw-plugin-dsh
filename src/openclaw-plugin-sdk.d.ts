/**
 * Minimal declarations for the OpenClaw Plugin SDK modules that ship without
 * .d.ts files. Only the surfaces this plugin calls are declared; the runtime
 * shapes are verified against openclaw 2026.10.5.
 */
declare module "openclaw/plugin-sdk/session-transcript-runtime" {
  export interface SessionTranscriptTarget {
    agentId?: string;
    sessionId?: string;
    sessionKey?: string;
    storePath?: string;
    threadId?: string | number;
  }

  export interface SessionTranscriptAppendParams extends SessionTranscriptTarget {
    config?: unknown;
    cwd?: string;
    runId?: string;
    message: unknown;
    /** "none" (default) skips publishing a transcript update. */
    updateMode?: "none" | "inline" | "file-only" | "always";
  }

  export interface SessionTranscriptAppendResult {
    kind: "result" | "rejected" | "suppressed";
    result?: {
      message: unknown;
      messageId: string;
      appended?: boolean;
      anchor?: { activeMessagePosition: number };
    };
    reason?: string;
  }

  export function appendSessionTranscriptMessageByIdentityStrict(
    params: SessionTranscriptAppendParams,
  ): Promise<SessionTranscriptAppendResult>;
}
