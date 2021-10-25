import { Change, Delete, Pin, socketIO, wrap } from "./deps/socket.ts";
import {
  createNewLineId,
  getPageIdAndCommitId,
  getProjectId,
  getUserId,
} from "./id.ts";

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

  async function pushWithRetry(changes: Change[], retry = 3) {
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
  }

  async function insert(text: string, beforeId = "_end") {
    const changes = text.split(/\n|\r\n/).map((line) => ({
      _insert: beforeId,
      lines: { text: line, id: createNewLineId(userId) },
    }));
    await pushWithRetry(changes);
  }
  async function remove(lineId: string) {
    await pushWithRetry([{ _delete: lineId, lines: -1 }]);
  }
  async function update(text: string, lineId: string) {
    await pushWithRetry([{ _update: lineId, lines: { text } }]);
  }
  return { insert, remove, update, listenPageUpdate: () => response("commit") };
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
    const res = await pushCommit(request, [{ delete: true }], {
      parentId,
      projectId,
      pageId,
      userId,
    });
    parentId = res.commitId;
  } catch (_e) {
    console.log("Faild to push a commit. Retry after pulling new commits");
    for (let i = 0; i < 3; i++) {
      try {
        parentId = (await getPageIdAndCommitId(project, title)).commitId;
        const res = await pushCommit(request, [{ delete: true }], {
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
}

export async function* listenStreamCommit(project: string) {
  const projectId = await getProjectId(project);

  const io = await socketIO();
  const { request, response } = wrap(io);
  await request("socket.io-request", {
    method: "room:join",
    data: { projectId, pageId: null, projectUpdatesStream: true },
  });
  yield* response("projectUpdatesStream:commit");
}
export async function* listenStreamEvent(project: string) {
  const projectId = await getProjectId(project);

  const io = await socketIO();
  const { request, response } = wrap(io);
  await request("socket.io-request", {
    method: "room:join",
    data: { projectId, pageId: null, projectUpdatesStream: true },
  });
  yield* response("projectUpdatesStream:event");
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
