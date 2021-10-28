import { diff, toExtendedChanges } from "./diff.ts";
import { Line, Page } from "./deps/scrapbox.ts";
import { Change } from "./deps/socket.ts";
import { createNewLineId } from "./id.ts";

type Options = {
  userId: string;
};
export function* diffToChanges(
  left: Omit<Line, "userId" | "updated" | "created">[],
  right: string[],
  { userId }: Options,
): Generator<Change, void, unknown> {
  const { buildSES } = diff(
    left.map(({ text }) => text),
    right,
  );
  let lineNo = 0;
  let lineId = left[0].id;
  for (const change of toExtendedChanges(buildSES())) {
    if (change.type !== "added" && lineId === "_end") {
      throw Error('lineId cannot be "_end" yet');
    }
    switch (change.type) {
      case "added":
        yield {
          _insert: lineId,
          lines: {
            id: createNewLineId(userId),
            text: change.value,
          },
        };
        break;

      case "deleted":
        yield {
          _delete: lineId,
          lines: -1,
        };
        break;
      case "replaced":
        yield {
          _update: lineId,
          lines: { text: change.value },
        };
        break;
    }
    lineNo++;
    lineId = left[lineNo]?.id ?? "_end";
  }
}
