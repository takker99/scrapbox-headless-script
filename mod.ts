import { Change, Delete, Pin, socketIO, wrap } from "./deps/socket.ts";
import {
  createNewLineId,
  getPageIdAndCommitId,
  getProjectId,
  getUserId,
} from "./id.ts";
import { getPage } from "./fetch.ts";
import { diffToChanges } from "./patch.ts";
import type { Line } from "./deps/scrapbox.ts";

export async function joinPageRoom(project: string, title: string) {
  const [{ pageId, commitId: initialCommitId, persistent }, projectId, userId] =
    await Promise.all([
      getPageIdAndCommitId(project, title),
      getProjectId(project),
      getUserId(),
    ]);
  let parentId = initialCommitId;
  let created = persistent;

  const io = await socketIO();
  const { request, response } = wrap(io);
  await request("socket.io-request", {
    method: "room:join",
    data: { projectId, pageId, projectUpdatesStream: false },
  });

  // subscribe the latest commit id
  (async () => {
    for await (const { id } of response("commit")) {
      parentId = id;
    }
  })();

  async function push(changes: Change[], retry = 3) {
    // 空ページのときはtitleを先にcommitしておく
    if (!created) {
      const res = await pushCommit(request, [{ title }], {
        parentId,
        projectId,
        pageId,
        userId,
      });
      parentId = res.commitId;
      created = true;
    }
    parentId = await pushWithRetry(request, changes, {
      parentId,
      projectId,
      pageId,
      userId,
      project,
      title,
      retry,
    });
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
    patch: async (update: (before: Line[]) => string[]) => {
      const oldLines = (await getPage(project, title)).lines;
      const newLines = update(oldLines);
      const changes = [...diffToChanges(oldLines, newLines, { userId })];
      await push(changes);
    },
    listenPageUpdate: () => response("commit"),
    cleanup: () => io.disconnect(),
  };
}
export async function deletePage(project: string, title: string) {
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

export async function* listenStreamCommit(project: string) {
  const projectId = await getProjectId(project);

  const io = await socketIO();
  const { request, response } = wrap(io);
  await request("socket.io-request", {
    method: "room:join",
    data: { projectId, pageId: null, projectUpdatesStream: true },
  });
  try {
    for await (const data of response("projectUpdatesStream:commit")) {
      yield data;
    }
  } finally {
    io.disconnect();
  }
}
export async function* listenStreamEvent(project: string) {
  const projectId = await getProjectId(project);

  const io = await socketIO();
  const { request, response } = wrap(io);
  await request("socket.io-request", {
    method: "room:join",
    data: { projectId, pageId: null, projectUpdatesStream: true },
  });
  try {
    for await (const data of response("projectUpdatesStream:event")) {
      yield data;
    }
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
  { projectId, pageId, userId, parentId }: PushCommitInit,
) {
  const res = await request("socket.io-request", {
    method: "commit",
    data: {
      kind: "page",
      projectId,
      parentId,
      pageId,
      userId,
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
  { projectId, pageId, userId, parentId, project, title, retry = 3 }:
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
      projectId,
      pageId,
      userId,
    });
    parentId = res.commitId;
  } catch (_e) {
    console.log("Faild to push a commit. Retry after pulling new commits");
    for (let i = 0; i < retry; i++) {
      try {
        parentId = (await getPageIdAndCommitId(project, title)).commitId;
        const res = await pushCommit(request, changes, {
          parentId,
          projectId,
          pageId,
          userId,
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
