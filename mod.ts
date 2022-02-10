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
import { createNewLineId, getProjectId, getUserId } from "./id.ts";
import { diffToChanges } from "./patch.ts";
import { applyCommit } from "./applyCommit.ts";
import { getPage } from "./deps/scrapbox-std.ts";
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
    page,
    projectId,
    userId,
  ] = await Promise.all([
    ensureEditablePage(project, title),
    getProjectId(project),
    getUserId(),
  ]);

  // 接続したページの情報
  let parentId = page.commitId;
  let created = page.persistent;
  let lines = page.lines;
  const pageId = page.id;

  const io = await socketIO();
  const { request, response } = wrap(io);
  await request("socket.io-request", {
    method: "room:join",
    data: { projectId, pageId, projectUpdatesStream: false },
  });

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
      const tryPush = async () => {
        const pending = update(lines);
        const newLines = pending instanceof Promise ? await pending : pending;
        const changes: Change[] = [
          ...diffToChanges(lines, newLines, { userId }),
        ];

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
        const newDescriptions = changedLines.slice(1, 6).map((lines) =>
          lines.text
        );
        if (oldDescriptions.join("\n") !== newDescriptions.join("\n")) {
          changes.push({ descriptions: newDescriptions });
        }

        // pushする
        const { commitId } = await pushCommit(request, changes, {
          parentId,
          projectId,
          pageId,
          userId,
        });

        // pushに成功したら、localにも変更を反映する
        parentId = commitId;
        created = true;
        lines = changedLines;
      };

      for (let i = 0; i < 3; i++) {
        try {
          await tryPush();
          break;
        } catch (_e: unknown) {
          if (i === 2) {
            throw Error("Faild to retry pushing.");
          }
          console.log(
            "Faild to push a commit. Retry after pulling new commits",
          );
          try {
            const page = await ensureEditablePage(project, title);
            parentId = page.commitId;
            created = page.persistent;
            lines = page.lines;
          } catch (e: unknown) {
            throw e;
          }
        }
      }
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
  const [
    { id: pageId, commitId: initialCommitId, persistent },
    projectId,
    userId,
  ] = await Promise.all([
    ensureEditablePage(project, title),
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

/** ページ全体を書き換える
 *
 * serverには書き換え前後の差分だけを送信する
 *
 * @param project 書き換えたいページのproject
 * @param title 書き換えたいページのタイトル
 * @param update 書き換え後の本文を作成する函数。引数には現在の本文が渡される
 */
export async function patch(
  project: string,
  title: string,
  update: (lines: Line[]) => string[] | Promise<string[]>,
): Promise<void> {
  const [
    page,
    projectId,
    userId,
  ] = await Promise.all([
    ensureEditablePage(project, title),
    getProjectId(project),
    getUserId(),
  ]);

  let persistent = page.persistent;
  let lines = page.lines;
  let parentId = page.commitId;
  const pageId = page.id;

  if (!persistent) return;

  const io = await socketIO();
  try {
    const { request } = wrap(io);

    const tryPush = async () => {
      const pending = update(lines);
      const newLines = pending instanceof Promise ? await pending : pending;
      const changes: Change[] = [
        ...diffToChanges(lines, newLines, { userId }),
      ];

      // 変更後のlinesを計算する
      const changedLines = applyCommit(lines, changes, {
        userId,
      });
      // タイトルの変更チェック
      // 空ページの場合もタイトル変更commitを入れる
      if (lines[0].text !== changedLines[0].text || !persistent) {
        changes.push({ title: changedLines[0].text });
      }
      // サムネイルの変更チェック
      const oldDescriptions = lines.slice(1, 6).map((line) => line.text);
      const newDescriptions = changedLines.slice(1, 6).map((lines) =>
        lines.text
      );
      if (oldDescriptions.join("\n") !== newDescriptions.join("\n")) {
        changes.push({ descriptions: newDescriptions });
      }

      // pushする
      await pushCommit(request, changes, {
        parentId,
        projectId,
        pageId,
        userId,
      });
    };

    // 3回retryする
    for (let i = 0; i < 3; i++) {
      try {
        await tryPush();
        break;
      } catch (_e: unknown) {
        if (i === 2) {
          throw Error("Faild to retry pushing.");
        }
        console.log(
          "Faild to push a commit. Retry after pulling new commits",
        );
        try {
          const page = await ensureEditablePage(project, title);
          parentId = page.commitId;
          persistent = page.persistent;
          lines = page.lines;
        } catch (e: unknown) {
          throw e;
        }
      }
    }
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
      const { commitId } = await ensureEditablePage(project, title);
      parentId = commitId;
      try {
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

async function ensureEditablePage(project: string, title: string) {
  const result = await getPage(project, title);

  // TODO: 編集不可なページはStream購読だけ提供する
  if (!result.ok) {
    throw new Error(`You have no privilege of editing "/${project}/${title}".`);
  }
  return result.value;
}
