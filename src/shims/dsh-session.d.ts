/**
 * Minimal local typings for the one runtime module this plugin imports from
 * the DSH host. Calibrated against DSH 0.2.2-rc.1
 * (@deepseek-ai/dsh-session/lib/types/index.d.ts). See docs/calibration.md.
 */
declare module '@deepseek-ai/dsh-session' {
  /** Opaque event envelope; only the fields this plugin reads are declared. */
  export interface SessionEvent {
    readonly type: string
    readonly seq: number
    readonly time?: number
    readonly ignorable?: boolean
    readonly data?: unknown
  }
  /**
   * The slice of the live Session API used by the host plugin and its tests.
   * `appendPluginRecord` / `pluginRecordOf` brand-check the receiver against
   * the module instance that created it (0.2.2), so this plugin resolves the
   * host's own copy at runtime — see `src/host-modules.ts`.
   */
  export declare class Session {
    readonly id: string
    deriveMessages(): readonly unknown[]
    /** Committed events owned by this Session (used by tests/probes). */
    ownEvents(): readonly SessionEvent[]
    /** Detached Session creation (tests/probes; live sessions come from the store). */
    static create(id: string): Session
  }
  /** One committed plugin-owned record. */
  export interface PluginRecord {
    readonly type: `plugin:${string}`
    readonly seq?: number
    readonly time?: number
    readonly data: unknown
  }
  export function appendPluginRecord(
    session: Session,
    type: `plugin:${string}`,
    data: Record<string, unknown>,
  ): number
  export function pluginRecordOf(event: SessionEvent): PluginRecord | undefined
}
