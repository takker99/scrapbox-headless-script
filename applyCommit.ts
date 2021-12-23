import type { CommitNotification } from "./deps/socket.ts";
import type { Line } from "./deps/scrapbox.ts";
import { getUnixTimeFromId } from "./id.ts";

export interface ApplyCommitProp {
  /** changesの作成日時
   *
   * UnixTimeか、UnixTimeを含んだidを渡す
   */
  updated: number | string;
  userId: string;
}
export function applyCommit(
  lines: readonly Line[],
  changes: CommitNotification["changes"],
  { updated, userId }: ApplyCommitProp,
) {
  const newLines = [...lines];
  const getPos = (lineId: string) => {
    const position = newLines.findIndex(({ id }) => id === lineId);
    if (position < 0) {
      throw RangeError(`No line whose id is ${lineId} found.`);
    }
    return position;
  };

  for (const change of changes) {
    if ("_insert" in change) {
      const created = getUnixTimeFromId(change.lines.id);
      const newLine = {
        text: change.lines.text,
        id: change.lines.id,
        userId,
        updated: created,
        created,
      };
      if (change._insert === "_end") {
        newLines.push(newLine);
      } else {
        newLines.splice(getPos(change._insert), 0, newLine);
      }
    } else if ("_update" in change) {
      const position = getPos(change._update);
      newLines[position].text = change.lines.text;
      newLines[position].updated = typeof updated === "string"
        ? getUnixTimeFromId(updated)
        : updated;
    } else if ("_delete" in change) {
      newLines.splice(getPos(change._delete), 1);
    }
  }
  return newLines;
}
