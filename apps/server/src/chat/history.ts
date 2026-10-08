/** One line in the captain's History about what it did for a client. Written through the autonomy event log. */
export interface HistoryLine {
  text: string;
  org: string;
  /** The incident or task it is about, to open it. */
  task?: string | undefined;
}

export type ChatHistory = (line: HistoryLine) => void;
