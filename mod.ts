import {
  Change,
  CommitNotification,
  Delete,
  ListenEventMap,
  Pin,
  ProjectUpdatesStreamCommit,
  ProjectUpdatesStreamEvent,
  socketIO,
  wrap,
} from "./deps/socket.ts";
import {
  createNewLineId,
  getPageIdAndCommitId,
  getProjectId,
  getUserId,
} from "./id.ts";
import { getPage } from "./fetch.ts";
import { diffToChanges } from "./patch.ts";
import { applyCommit } from "./applyCommit.ts";
import type { Line } from "./deps/scrapbox.ts";
export type {
  CommitNotification,
  ProjectUpdatesStreamCommit,
  ProjectUpdatesStreamEvent,
};

export interface JoinPageRoomResult {
  /** 特定の位置にテキストを挿入する
   *
   * @param text - 挿入したいテキスト (複数行も可)
   * @param beforeId - この行IDが指し示す行の上に挿入する。末尾に挿入する場合は`_end`を指定する
   */
  insert: (text: string, beforeId: string) => Promise<void>;
  /** 特定の行を削除する
   *
   * @param lineId 削除したい行の行ID
   */
  remove: (lineId: string) => Promise<void>;
  /** 特定の位置のテキストを書き換える
   *
   * @param text - 書き換え後のテキスト (改行は不可)
   * @param lineId - 書き換えたい行の行ID
   */
  update: (text: string, lineId: string) => Promise<void>;

  /** ページ全体を書き換える
   *
   * `update()`で現在の本文から書き換え後の本文を作ってもらう。
   * serverには書き換え前後の差分だけを送信する
   *
   * @param update 書き換え後の本文を作成する函数。引数には現在の本文が渡される
   */
  patch: (update: (before: Line[]) => string[]) => Promise<void>;
  /** ページの更新情報を購読する */
  listenPageUpdate: () => AsyncGenerator<CommitNotification, void, unknown>;
  /** ページの操作を終了する。これを呼び出すと他のmethodsは使えなくなる
   *
   * 内部的にはwebsocketを切断している
   */
  cleanup: () => void;
}
/** 指定したページを操作する
 *
 * @param project 操作したいページのproject
 * @param title 操作したいページのタイトル
 */
export async function joinPageRoom(
  project: string,
  title: string,
): Promise<JoinPageRoomResult> {
  const [
    { commitId, lines: _lines, id: pageId, persistent },
    projectId,
    userId,
  ] = await Promise.all([
    getPage(project, title),
    getProjectId(project),
    getUserId(),
  ]);

  const io = await socketIO();
  const { request, response } = wrap(io);
  await request("socket.io-request", {
    method: "room:join",
    data: { projectId, pageId, projectUpdatesStream: false },
  });

  // 接続したページの情報
  /** HEADのcommit id */ let parentId = commitId;
  /** 中身のあるページかどうか */ let created = persistent;
  /** ページ本文 */ let lines = _lines;

  // subscribe the latest commit
  (async () => {
    for await (const { id, changes } of response("commit")) {
      parentId = id;
      lines = applyCommit(lines, changes, { updated: id, userId });
    }
  })();

  async function push(changes: Change[], retry = 3) {
    // 変更後のlinesを計算する
    const changedLines = applyCommit(lines, changes, {
      userId,
    });
    // タイトルの変更チェック
    // 空ページの場合もタイトル変更commitを入れる
    if (lines[0].text !== changedLines[0].text || !created) {
      changes.push({ title: changedLines[0].text });
    }
    // サムネイルの変更チェック
    const oldDescriptions = lines.slice(1, 6).map((line) => line.text);
    const newDescriptions = changedLines.slice(1, 6).map((lines) => lines.text);
    if (oldDescriptions.join("\n") !== newDescriptions.join("\n")) {
      changes.push({ descriptions: newDescriptions });
    }

    // serverにpushする
    parentId = await pushWithRetry(request, changes, {
      parentId,
      projectId,
      pageId,
      userId,
      project,
      title,
      retry,
    });
    // pushに成功したら、localにも変更を反映する
    created = true;
    lines = changedLines;
  }

  return {
    insert: async (text: string, beforeId = "_end") => {
      const changes = text.split(/\n|\r\n/).map((line) => ({
        _insert: beforeId,
        lines: { text: line, id: createNewLineId(userId) },
      }));
      await push(changes);
    },
    remove: (lineId: string) => push([{ _delete: lineId, lines: -1 }]),
    update: (text: string, lineId: string) =>
      push([{ _update: lineId, lines: { text } }]),
    patch: async (update: (before: Line[]) => string[] | Promise<string[]>) => {
      const pending = update(lines);
      const newLines = pending instanceof Promise ? await pending : pending;
      const changes = [...diffToChanges(lines, newLines, { userId })];
      await push(changes);
    },
    listenPageUpdate: () => response("commit"),
    cleanup: () => {
      io.disconnect();
    },
  };
}

/** 指定したページを削除する
 *
 * @param project 削除したいページのproject
 * @param title 削除したいページのタイトル
 */
export async function deletePage(
  project: string,
  title: string,
): Promise<void> {
  const [{ pageId, commitId: initialCommitId, persistent }, projectId, userId] =
    await Promise.all([
      getPageIdAndCommitId(project, title),
      getProjectId(project),
      getUserId(),
    ]);
  let parentId = initialCommitId;

  if (!persistent) return;

  const io = await socketIO();
  const { request } = wrap(io);

  try {
    parentId = await pushWithRetry(request, [{ deleted: true }], {
      projectId,
      pageId,
      parentId,
      userId,
      project,
      title,
    });
  } finally {
    io.disconnect();
  }
}

/** Streamを購読する
 *
 * @param project 購読したいproject
 * @param events 購読したいeventの種類。複数種類を指定できる
 */
export async function* listenStream<EventName extends keyof ListenEventMap>(
  project: string,
  ...events: EventName[]
) {
  const projectId = await getProjectId(project);

  const io = await socketIO();
  const { request, response } = wrap(io);
  await request("socket.io-request", {
    method: "room:join",
    data: { projectId, pageId: null, projectUpdatesStream: true },
  });
  try {
    yield* response(
      ...(events.length > 0 ? events : [
        "projectUpdatesStream:event",
        "projectUpdatesStream:commit",
      ] as const),
    );
  } finally {
    io.disconnect();
  }
}

type RequestFunc = ReturnType<typeof wrap>["request"];
type PushCommitInit = {
  parentId: string;
  projectId: string;
  pageId: string;
  userId: string;
};

async function pushCommit(
  request: RequestFunc,
  changes: Change[] | [Delete] | [Pin],
  commitInit: PushCommitInit,
) {
  if (changes.length === 0) return { commitId: commitInit.parentId };
  const res = await request("socket.io-request", {
    method: "commit",
    data: {
      kind: "page",
      ...commitInit,
      changes,
      cursor: null,
      freeze: true,
    },
  });
  return res as { commitId: string };
}

async function pushWithRetry(
  request: RequestFunc,
  changes: Change[] | [Delete] | [Pin],
  { project, title, retry = 3, parentId, ...commitInit }:
    & PushCommitInit
    & {
      project: string;
      title: string;
      retry?: number;
    },
) {
  try {
    const res = await pushCommit(request, changes, {
      parentId,
      ...commitInit,
    });
    parentId = res.commitId;
  } catch (_e) {
    console.log("Faild to push a commit. Retry after pulling new commits");
    for (let i = 0; i < retry; i++) {
      try {
        parentId = (await getPageIdAndCommitId(project, title)).commitId;
        const res = await pushCommit(request, changes, {
          parentId,
          ...commitInit,
        });
        parentId = res.commitId;
        console.log("Success in retrying");
        break;
      } catch (_e) {
        continue;
      }
    }
    throw Error("Faild to retry pushing.");
  }
  return parentId;
}
