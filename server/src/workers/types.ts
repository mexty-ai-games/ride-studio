import type { TaskEvent } from "../../../shared/protocol.js";

export interface TaskSpec {
  taskId: string;
  brief: string;
  /** Runner-specific session handle from an earlier run of the same worker. */
  resume?: string;
  model: string;
  allowedTools: string[];
  systemAppend: string;
  maxTurns: number;
}
export type Emit = (e: TaskEvent) => void;
export interface Running {
  stop(): void;
}
